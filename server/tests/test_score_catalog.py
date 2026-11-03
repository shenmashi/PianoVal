import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ROOT, Settings
from app.main import create_app
from app.practice import ComparisonRequest, compare_score, score_catalog, score_data


def test_downloaded_corpus_has_fourteen_pieces_and_ten_additional_audio_pairs():
    catalog = score_catalog()
    assert len(catalog) == 14
    assert sum(len(piece["versions"]) for piece in catalog) == 17
    assert sum(bool(version["assets"].get("accompaniment"))
               for piece in catalog[4:] for version in piece["versions"]) == 10
    for piece in catalog:
        directory = ROOT / "static/scores" / piece["id"]
        manifest = json.loads((directory / "provenance.json").read_text())
        files = {asset["file"]: asset for asset in manifest["assets"]}
        for version in piece["versions"]:
            for filename in version["assets"].values():
                content = (directory / filename).read_bytes()
                assert hashlib.sha256(content).hexdigest() == files[filename]["sha256"]
                assert not content.lstrip().startswith(b"<!DOCTYPE html")


@pytest.mark.parametrize("piece", score_catalog(), ids=lambda piece: piece["title"])
def test_each_version_has_a_complete_grid_both_hands_and_comparable_excerpt(piece):
    for version in piece["versions"]:
        score = score_data(version["id"], piece["id"])
        grid = score["measureStartsSeconds"]
        assert len(grid) == score["bars"] + 1
        assert all(right > left for left, right in zip(grid, grid[1:]))
        assert {note["hand"] for note in score["notes"]} == {"left", "right"}
        assert max(note["onsetSeconds"] for note in score["notes"]) < grid[-1] + .024
        for hand in ("left", "right", "both"):
            actual = [{key: note[key] for key in ("midi", "onsetSeconds", "velocity")}
                      for note in score["notes"] if note["measure"] <= 2 and (hand == "both" or note["hand"] == hand)]
            # Deduplicate a physical key shared by both hands.
            actual = list({(note["midi"], note["onsetSeconds"]): note for note in actual}.values())
            result = compare_score(ComparisonRequest(pieceId=piece["id"], difficulty=version["id"], hand=hand, endMeasure=2), actual)
            assert result["metrics"]["fp"] == result["metrics"]["fn"] == 0


def test_pickup_changing_meters_and_first_second_endings():
    normal = score_data("normal")
    assert normal["sourceBars"] == 38 and normal["bars"] == 69
    assert normal["sourceMeasures"][35:38] == [36, 5, 6]
    assert normal["sourceMeasures"][-3:] == [35, 37, 38]
    assert len(normal["sourceMeasureQuarters"]) == 39
    waltz = score_data("custom-lemq170", "piece-mvz2oen46nl1")
    assert waltz["measureQuarters"][:3] == [0, 3, 6]
    pickup = score_data("custom-br8y359", "piece-mvyyd3mk2zte")
    assert pickup["measureQuarters"][:3] == [0, 1, 5]
    changing = score_data("custom-86x714", "piece-mvz2bwmiwrzw")
    lengths = [b - a for a, b in zip(changing["measureQuarters"], changing["measureQuarters"][1:])]
    assert len(set(lengths)) > 3
    repeated = score_data("custom-jqb7526", "piece-mvyyl7zaljt5")
    assert repeated["sourceBars"] == 35 and repeated["bars"] == 41
    assert repeated["sourceMeasures"][32:38] == [25, 26, 27, 28, 29, 30]
    assert repeated["sourceMeasures"][38:] == [33, 34, 35]


def test_catalog_api_and_unknown_selections(tmp_path):
    class CatalogOnlyModel:
        def __init__(self, settings):
            self.settings = settings

    with TestClient(create_app(Settings(studio_dir=tmp_path), CatalogOnlyModel)) as client:
        response = client.get("/api/studio/practice/catalog")
        assert response.status_code == 200 and len(response.json()["pieces"]) == 14
        response = client.get("/api/studio/practice/custom-r6f5430?pieceId=piece-mvz3s8o8c7b5")
        assert response.status_code == 200 and response.json()["tempo"] == 70
        assert client.get("/api/studio/practice/easy?pieceId=unknown").status_code == 400
        assert client.get("/api/studio/practice/easy?pieceId=piece-mvz3s8o8c7b5").status_code == 400


def test_subpath_page_resolves_resources_against_the_proxy_prefix(tmp_path):
    with TestClient(create_app(Settings(studio_dir=tmp_path), lambda settings: None), root_path='/pianoval') as client:
        html = client.get('/').text
        assert '<base href="/pianoval/">' in html
        assert 'src="/static/' not in html and 'href="/static/' not in html
