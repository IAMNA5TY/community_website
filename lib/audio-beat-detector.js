const SAMPLE_RATE = 22050;
const CHUNK_SAMPLES = 1024;

class AudioBeatDetector {
  constructor(options = {}) {
    this.sensitivity = clamp(Number(options.sensitivity) || 6, 1, 10);
    this.minBeatGapMs = Number(options.minBeatGapMs) || 170;
    this.energyHistory = [];
    this.historySize = 36;
    this.lastBeatAt = 0;
    this.lastEnergy = 0;
    this.lastMeasuredEnergy = 0;
    this.lastBeatStrength = 0.5;
  }

  getLastEnergy() {
    return this.lastMeasuredEnergy;
  }

  processInt16(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount < 64) return false;

    let lowEnergy = 0;
    let totalEnergy = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = buffer.readInt16LE(i * 2);
      const abs = Math.abs(sample);
      totalEnergy += abs;
      if (i % 4 === 0) {
        lowEnergy += abs;
      }
    }

    const bassEnergy = lowEnergy / Math.ceil(sampleCount / 4);
    const rms = totalEnergy / sampleCount;
    const energy = bassEnergy * 0.72 + rms * 0.28;
    this.lastMeasuredEnergy = energy;

    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.historySize) {
      this.energyHistory.shift();
    }

    const average =
      this.energyHistory.reduce((sum, value) => sum + value, 0) /
      this.energyHistory.length;
    const variance =
      this.energyHistory.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      this.energyHistory.length;
    const stdDev = Math.sqrt(variance);
    const peak = Math.max(...this.energyHistory);
    const rise = energy - this.lastEnergy;
    this.lastEnergy = energy;

    const sensFactor = (11 - this.sensitivity) * 0.07;
    const threshold = average + stdDev * (0.85 + sensFactor);
    const now = Date.now();
    const sinceLast = now - this.lastBeatAt;
    const strongHit = energy > threshold && energy > peak * 0.66;
    const sharpRise = rise > average * 0.22 + stdDev * 0.32 && energy > average * 0.98;

    if (sinceLast >= this.minBeatGapMs && (strongHit || sharpRise)) {
      const headroom = Math.max(peak - average, average * 0.15, 1);
      const hit = clamp((energy - average) / headroom, 0, 1);
      this.lastBeatStrength = clamp(0.3 + hit * 0.7, 0, 1);
      this.lastBeatAt = now;
      return true;
    }

    return false;
  }

  getLastBeatStrength() {
    return this.lastBeatStrength ?? 0.5;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  AudioBeatDetector,
  SAMPLE_RATE,
  CHUNK_SAMPLES,
};
