"""
Audio preprocessing before speech recognition: one pipeline for uploads, the STT lab and (behind
flags) live browser and phone turns.

    decode → high-pass / gain → noise suppression → voice isolation → VAD → trim → STT

Noise suppression (`noise.py`, the CleanVoice service) and voice isolation (`isolation.py`,
suppressing *other voices*) are separate stages with separate providers, and every stage reports
whether it actually ran. See docs/audio-pipeline.md.
"""
