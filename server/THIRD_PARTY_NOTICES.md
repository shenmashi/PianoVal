# Third-party model and source

This service includes the original **Onsets & Velocities** model source from
[andres-fr/iamusica_training](https://github.com/andres-fr/iamusica_training),
commit `629ff11aceadf01ecc456b1c7f26a104f7e1e571`.

- Author: Andrés Fernández Rodríguez / IAMúsica project.
- Paper: *Onsets and Velocities: Affordable Real-Time Piano Transcription Using
  Convolutional Neural Networks*, EUSIPCO 2023,
  <https://arxiv.org/abs/2303.04485>.
- Unmodified source: `vendor/ov_piano/`.
- Original license: GPL-3.0, retained in `vendor/O&V-LICENSE.txt`.
- Original documentation: `vendor/O&V-README.md`.
- Checkpoint: `assets/OnsetsAndVelocities_2023_03_04_09_53_53.289step=43500_f1=0.9675__0.9480.torch`
  in the pinned upstream repository.
- Local checkpoint: `models/onsets-velocities.torch`, 12,722,905 bytes.
- SHA256: `90901ff8c7cb15c76a4da2f4aca643a10295c834ac9e549ee16097d4bbce642d`.

The application adapter in `app/model.py` calls the original network and
decoder. Windowing, audio protocol and per-session buffering are implemented
by this project. Changes to context length or preprocessing need separate
accuracy evaluation; the original paper's benchmark metrics do not describe
this service's accuracy on Pad recordings.

## Score rendering

OpenSheetMusicDisplay 1.9.2, BSD-3-Clause. Bundled under `static/vendor/`;
license retained in `static/vendor/OSMD-LICENSE.txt`.
Source: <https://github.com/opensheetmusicdisplay/opensheetmusicdisplay>.

The user-requested public practice resources are retained under
`static/scores/<piece-id>/` (14 pieces, 17 selected versions). The local index is
`static/scores/catalog.json`; original URLs and hashes are in each `provenance.json`;
this does not assert ownership or a redistribution license for those scores.

## Virtual piano samples

Salamander Grand Piano v3, by **Alexander Holm**, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
Instrument: <https://sfzinstruments.github.io/pianos/salamander/>.
MP3 distribution: <https://github.com/Tonejs/audio/tree/master/salamander>.
Thirty unchanged MP3 samples are bundled under `static/piano-samples/`, with
per-file URLs / hashes and attribution. Browser playback pitch-shifts nearby
samples and applies gain / release envelopes. No Tone.js runtime is bundled.
