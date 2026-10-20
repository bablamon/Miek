"""Write a 30 s, 24-bit / 48 kHz test FLAC for the mock Soulseek test: make_tone.py out.flac
(needs numpy and soundfile)"""
import sys
import numpy as np
import soundfile as sf

r = 48000
t = np.arange(30 * r) / r
x = np.stack([0.3 * np.sin(2 * np.pi * (220 + 10 * t) * t), 0.3 * np.sin(2 * np.pi * 330 * t) + 0.01 * np.random.randn(len(t))], 1)
sf.write(sys.argv[1], x, r, subtype='PCM_24')
