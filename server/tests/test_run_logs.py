import uuid

import numpy as np

from app.dataset import StudioStore
from app.dataset import atomic_json
from app.test_runs import TestRunReport as RunReport, load_report, report_path, save_report, summaries


def test_test_logs_persist_audio_identity_raw_errors_and_model_without_training(tmp_path):
    store = StudioStore(tmp_path)
    record = store.create_record('simulated', np.zeros(16000, dtype=np.float32), provenance='simulated')
    report = RunReport(id=str(uuid.uuid4()), status='completed', final=True,
        recordingId=record['id'], settings={'pieceId':'listen-to-mom','difficulty':'easy','hand':'both'},
        model={'threshold':.74,'checkpointSha256':'fixed-model'},
        analysis={'accuracy':{'value':.5},'rows':[{'pitches':[55,74],'heard':[55,67,74],
            'extra':[67],'missing':[],'modelEvents':[{'midi':67,'onsetProbability':.740038}]}]})
    saved = save_report(store, report)
    assert report_path(store, report.id).is_file()
    assert saved['audioSha256'] == record['audioSha256']
    assert saved['diagnostics']['octaveExtraGroups'] == 1
    assert saved['diagnostics']['nearThresholdExtraGroups'] == 1
    assert saved['diagnostics']['hasReplayAudio']
    assert len(summaries(StudioStore(tmp_path))) == 1
    assert store.list_jobs() == []
    assert store.get_record(record['id'])['split'] == 'unassigned'
    replay = report.model_copy(update={'id':str(uuid.uuid4())})
    assert save_report(store, replay)['replayComparisonKey'] == saved['replayComparisonKey']
    different = report.model_copy(update={'id':str(uuid.uuid4()),'model':{'threshold':.8}})
    assert save_report(store, different)['replayComparisonKey'] != saved['replayComparisonKey']


def test_failed_run_without_audio_is_saved_without_claiming_a_replay(tmp_path):
    store = StudioStore(tmp_path)
    result = save_report(store, RunReport(id=str(uuid.uuid4()), status='failed', final=False,
        settings={}, analysis={'rows':[]}, scope='real-student'))
    assert result['scope'] == 'synthetic-piano-direct-pcm'
    assert result['audioSha256'] is None and result['replayComparisonKey'] is None
    assert not result['diagnostics']['hasReplayAudio']


def test_microphone_review_and_disconnected_audio_are_retained_without_fabricating_accuracy(tmp_path):
    store = StudioStore(tmp_path)
    session_id, test_id = str(uuid.uuid4()), str(uuid.uuid4())
    record = store.create_record('partial microphone', np.zeros(16000, dtype=np.float32))
    atomic_json(store.root / 'stream-runs' / (uuid.UUID(session_id).hex + '.json'), {
        'sessionId':session_id, 'testId':test_id, 'context':{'hand':'left'}, 'startedAt':1,
        'recordingKind':'microphone', 'status':'interrupted', 'recordingId':record['id'],
        'windows':[{'events':[{'midi':67,'onsetProbability':.740038}], 'inferenceMs':10}],
    })
    report = RunReport(id=test_id, sessionId=session_id, mode='waiting-follow', status='failed', final=False,
        settings={'hand':'left'}, source={'kind':'microphone'}, analysis={'accuracy':{'value':1}},
        decisions=[{'action':'wait','teacherReview':'should-advance'}, {'action':'advance','teacherReview':'should-wait'}])
    saved = save_report(store, report)
    assert saved['analysis']['accuracy'] is None
    assert saved['teacherReview'] == {'count':2,'falseBlocks':1,'falsePasses':1,'correctDecisions':0,'accuracy':0,'totalDecisions':2}
    loaded = load_report(store, test_id)
    assert loaded['recordingId'] == record['id']
    assert loaded['stream']['windows'][0]['events'][0]['onsetProbability'] == .740038
    history = summaries(store)
    assert len(history) == 1 and history[0]['recordingId'] == record['id']
    assert history[0]['scope'] == 'microphone-unreviewed' and history[0]['accuracy'] is None
    assert store.list_jobs() == []
