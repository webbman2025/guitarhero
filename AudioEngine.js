const FFT_SIZE = 2048;
const BANDPASS_FREQ = 440;
const BANDPASS_Q = 1.0;
const RMS_GATE = 0.015;
const MIN_FREQ = 70;
const MAX_FREQ = 420;

export class AudioEngine {
  /** @type {AudioContext | null} */
  #context = null;
  /** @type {MediaStream | null} */
  #stream = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  #source = null;
  /** @type {BiquadFilterNode | null} */
  #bandpass = null;
  /** @type {AnalyserNode | null} */
  #analyser = null;
  /** @type {Float32Array | null} */
  #timeBuffer = null;
  /** @type {boolean} */
  #simulateMode = false;
  /** @type {OscillatorNode | null} */
  #oscillator = null;
  /** @type {GainNode | null} */
  #simGain = null;
  /** @type {GainNode | null} */
  #monitorGain = null;
  /** @type {OscillatorNode | null} */
  #harmonicOsc = null;
  /** @type {GainNode | null} */
  #harmonicGain = null;

  get isRunning() {
    return (
      this.#context?.state === "running" &&
      (this.#stream != null || this.#simulateMode)
    );
  }

  /** Mic/sim graph still open (e.g. background suspend — do not re-prompt). */
  get hasActiveSession() {
    return (
      this.#context != null &&
      this.#context.state !== "closed" &&
      (this.#stream != null || this.#simulateMode)
    );
  }

  get simulateMode() {
    return this.#simulateMode;
  }

  get sampleRate() {
    return this.#context?.sampleRate ?? 44100;
  }

  /**
   * Create AudioContext and mic or simulated-tone graph — call only from a user gesture.
   * @param {{ simulate?: boolean, frequency?: number }} [options]
   */
  async start(options = {}) {
    if (this.isRunning) {
      return;
    }

    const simulate = options.simulate === true;
    const frequency = options.frequency ?? 196;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.#context = new AudioCtx();
    this.#simulateMode = simulate;

    this.#bandpass = this.#context.createBiquadFilter();
    this.#bandpass.type = "bandpass";
    this.#bandpass.frequency.value = BANDPASS_FREQ;
    this.#bandpass.Q.value = BANDPASS_Q;

    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = FFT_SIZE;
    this.#analyser.smoothingTimeConstant = 0;
    this.#timeBuffer = new Float32Array(this.#analyser.fftSize);

    if (simulate) {
      this.#oscillator = this.#context.createOscillator();
      this.#simGain = this.#context.createGain();
      this.#monitorGain = this.#context.createGain();
      this.#oscillator.type = "sine";
      this.#oscillator.frequency.value = frequency;
      this.#simGain.gain.value = 0.45;
      this.#oscillator.connect(this.#simGain);
      // Bypass 440 Hz bandpass — guitar strings are ~82–330 Hz.
      this.#simGain.connect(this.#analyser);

      this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(frequency);
      this.#simGain.connect(this.#monitorGain);
      this.#monitorGain.connect(this.#context.destination);

      this.#harmonicOsc = this.#context.createOscillator();
      this.#harmonicGain = this.#context.createGain();
      this.#harmonicOsc.type = "sine";
      AudioEngine.#syncHarmonicMonitor(this.#harmonicOsc, this.#harmonicGain, frequency);
      this.#harmonicOsc.connect(this.#harmonicGain);
      this.#harmonicGain.connect(this.#monitorGain);

      this.#oscillator.start();
      this.#harmonicOsc.start();
    } else {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
        video: false,
      });

      this.#source = this.#context.createMediaStreamSource(this.#stream);
      this.#source.connect(this.#bandpass);
      this.#bandpass.connect(this.#analyser);
    }

    await this.#context.resume();
  }

  async suspend() {
    if (this.#context?.state === "running") {
      await this.#context.suspend();
    }
  }

  async resume() {
    if (this.#context?.state === "suspended") {
      await this.#context.resume();
    }
  }

  /** @param {number} frequency */
  setSimulatedFrequency(frequency) {
    if (this.#oscillator) {
      this.#oscillator.frequency.value = frequency;
    }
    if (this.#monitorGain) {
      this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(frequency);
    }
    if (this.#harmonicOsc && this.#harmonicGain) {
      AudioEngine.#syncHarmonicMonitor(this.#harmonicOsc, this.#harmonicGain, frequency);
    }
  }

  /** Low open E (~82 Hz) is hard to hear on phone speakers — boost monitor + 2× harmonic. */
  static #monitorLevelForFrequency(frequency) {
    if (frequency < 95) {
      return 0.28;
    }
    if (frequency < 130) {
      return 0.18;
    }
    return 0.12;
  }

  /**
   * @param {OscillatorNode} harmonicOsc
   * @param {GainNode} harmonicGain
   * @param {number} fundamentalHz
   */
  static #syncHarmonicMonitor(harmonicOsc, harmonicGain, fundamentalHz) {
    if (fundamentalHz < 130) {
      harmonicOsc.frequency.value = fundamentalHz * 2;
      harmonicGain.gain.value = fundamentalHz < 95 ? 0.35 : 0.18;
    } else {
      harmonicGain.gain.value = 0;
    }
  }

  stop() {
    if (this.#oscillator) {
      try {
        this.#oscillator.stop();
      } catch {
        /* already stopped */
      }
      this.#oscillator.disconnect();
    }
    if (this.#harmonicOsc) {
      try {
        this.#harmonicOsc.stop();
      } catch {
        /* already stopped */
      }
      this.#harmonicOsc.disconnect();
    }
    this.#harmonicGain?.disconnect();
    this.#simGain?.disconnect();
    this.#monitorGain?.disconnect();
    this.#oscillator = null;
    this.#simGain = null;
    this.#monitorGain = null;
    this.#harmonicOsc = null;
    this.#harmonicGain = null;
    this.#simulateMode = false;

    this.#source?.disconnect();
    this.#bandpass?.disconnect();
    this.#analyser?.disconnect();
    this.#source = null;
    this.#bandpass = null;
    this.#analyser = null;

    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        track.stop();
      }
      this.#stream = null;
    }

    if (this.#context) {
      void this.#context.close();
      this.#context = null;
    }
    this.#timeBuffer = null;
  }

  /**
   * @returns {Float32Array | null}
   */
  readTimeDomainBuffer() {
    if (!this.#analyser || !this.#timeBuffer) {
      return null;
    }
    this.#analyser.getFloatTimeDomainData(this.#timeBuffer);
    return this.#timeBuffer;
  }

  /**
   * RMS gate + autocorrelation pitch detection.
   * @param {Float32Array} buffer
   * @returns {false | { frequency: number, confidence: number, rms: number }}
   */
  /**
   * @param {Float32Array} buffer
   * @param {{ relaxGates?: boolean }} [options]
   */
  detectPitch(buffer, options = {}) {
    const rmsGate = options.relaxGates ? 0.004 : RMS_GATE;
    const rms = AudioEngine.computeRms(buffer);
    if (rms < rmsGate) {
      return false;
    }

    const downFactor = Math.max(1, Math.round(this.sampleRate / 8000));
    const downsampled = AudioEngine.#downsample(buffer, downFactor);
    const effectiveRate = this.sampleRate / downFactor;
    const pitch = AudioEngine.#autocorrelate(downsampled, effectiveRate);

    if (!pitch) {
      return false;
    }

    return {
      frequency: pitch.frequency,
      confidence: pitch.confidence,
      rms,
    };
  }

  /** @param {Float32Array} samples */
  static computeRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
  }

  /** @param {Float32Array} samples @param {number} factor */
  static #downsample(samples, factor) {
    const len = Math.floor(samples.length / factor);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = samples[i * factor];
    }
    return out;
  }

  /**
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @returns {{ frequency: number, confidence: number } | null}
   */
  static #autocorrelate(samples, sampleRate) {
    const minPeriod = Math.floor(sampleRate / MAX_FREQ);
    const maxPeriod = Math.ceil(sampleRate / MIN_FREQ);
    const size = samples.length;

    let energy = 0;
    for (let i = 0; i < size; i++) {
      energy += samples[i] * samples[i];
    }
    if (energy <= 1e-10) {
      return null;
    }

    let bestOffset = -1;
    let bestNorm = 0;

    for (let offset = minPeriod; offset <= maxPeriod; offset++) {
      let corr = 0;
      for (let i = 0; i < size - offset; i++) {
        corr += samples[i] * samples[i + offset];
      }
      const normalized = corr / energy;
      if (normalized > bestNorm) {
        bestNorm = normalized;
        bestOffset = offset;
      }
    }

    if (bestOffset <= 0) {
      return null;
    }

    let refinedPeriod = bestOffset;
    if (bestOffset > minPeriod && bestOffset < maxPeriod) {
      const prev = AudioEngine.#correlationNorm(samples, bestOffset - 1, energy);
      const next = AudioEngine.#correlationNorm(samples, bestOffset + 1, energy);
      const denom = 2 * (2 * bestNorm - prev - next);
      if (Math.abs(denom) > 1e-9) {
        refinedPeriod = bestOffset + (prev - next) / denom;
      }
    }

    const frequency = sampleRate / refinedPeriod;
    if (frequency < MIN_FREQ || frequency > MAX_FREQ) {
      return null;
    }

    return { frequency, confidence: bestNorm };
  }

  /** @param {Float32Array} samples @param {number} offset @param {number} energy */
  static #correlationNorm(samples, offset, energy) {
    let corr = 0;
    const size = samples.length;
    for (let i = 0; i < size - offset; i++) {
      corr += samples[i] * samples[i + offset];
    }
    return corr / energy;
  }
}

export { RMS_GATE, FFT_SIZE };
