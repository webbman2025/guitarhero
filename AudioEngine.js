const FFT_SIZE = 2048;
const BANDPASS_FREQ = 440;
const BANDPASS_Q = 1.0;
const RMS_GATE = 0.015;
const MIN_FREQ = 70;
const MAX_FREQ = 420;

/** Harmonic mix approximating a plucked string (fundamental stays dominant for pitch). */
const GUITAR_PARTIALS = [
  { ratio: 1, level: 1, wave: "triangle" },
  { ratio: 2, level: 0.52, wave: "sine" },
  { ratio: 3, level: 0.27, wave: "sine" },
  { ratio: 4, level: 0.14, wave: "sine" },
  { ratio: 5, level: 0.07, wave: "sine" },
];

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
  /** @type {GainNode | null} */
  #simGain = null;
  /** @type {GainNode | null} */
  #monitorGain = null;
  /** @type {BiquadFilterNode | null} */
  #simToneFilter = null;
  /** @type {{ osc: OscillatorNode, level: GainNode, ratio: number }[]} */
  #simPartials = [];
  /** Steady fundamental for analyser — not affected by pluck envelope. */
  /** @type {OscillatorNode | null} */
  #analysisOsc = null;
  /** @type {GainNode | null} */
  #analysisGain = null;

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
      this.#buildSimulatedGuitarGraph(frequency);
      this.#triggerSimPluck();
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

  /** @param {number} fundamentalHz */
  #buildSimulatedGuitarGraph(fundamentalHz) {
    if (!this.#context) {
      return;
    }

    this.#analysisOsc = this.#context.createOscillator();
    this.#analysisGain = this.#context.createGain();
    this.#analysisOsc.type = "sine";
    this.#analysisOsc.frequency.value = fundamentalHz;
    this.#analysisGain.gain.value = 0.42;
    this.#analysisOsc.connect(this.#analysisGain);
    this.#analysisGain.connect(this.#analyser);
    this.#analysisOsc.start();

    this.#simGain = this.#context.createGain();
    this.#simGain.gain.value = 0.0001;

    this.#simToneFilter = this.#context.createBiquadFilter();
    this.#simToneFilter.type = "lowpass";
    this.#simToneFilter.frequency.value = 3200;
    this.#simToneFilter.Q.value = 0.55;

    this.#monitorGain = this.#context.createGain();
    this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(fundamentalHz);

    for (const partial of GUITAR_PARTIALS) {
      const osc = this.#context.createOscillator();
      const level = this.#context.createGain();
      osc.type = partial.wave;
      osc.frequency.value = fundamentalHz * partial.ratio;
      level.gain.value = partial.level * 0.16;
      osc.connect(level);
      level.connect(this.#simGain);
      osc.start();
      this.#simPartials.push({ osc, level, ratio: partial.ratio });
    }

    this.#simGain.connect(this.#simToneFilter);
    this.#simToneFilter.connect(this.#monitorGain);
    this.#monitorGain.connect(this.#context.destination);
  }

  /** @param {number} fundamentalHz */
  #setPartialFrequencies(fundamentalHz) {
    if (this.#analysisOsc) {
      this.#analysisOsc.frequency.value = fundamentalHz;
    }
    for (const { osc, ratio } of this.#simPartials) {
      osc.frequency.value = fundamentalHz * ratio;
    }
    if (this.#monitorGain) {
      this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(fundamentalHz);
    }
  }

  #triggerSimPluck() {
    if (!this.#context || !this.#simGain) {
      return;
    }

    const t = this.#context.currentTime;
    const peak = 0.95;
    const sustain = 0.68;

    this.#simGain.gain.cancelScheduledValues(t);
    this.#simGain.gain.setValueAtTime(0.0001, t);
    this.#simGain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    this.#simGain.gain.exponentialRampToValueAtTime(sustain, t + 0.07);
    this.#simGain.gain.setTargetAtTime(sustain * 0.75, t + 0.07, 2.8);

    const sr = this.#context.sampleRate;
    const pickSamples = Math.max(1, Math.floor(sr * 0.006));
    const pick = this.#context.createBuffer(1, pickSamples, sr);
    const data = pick.getChannelData(0);
    for (let i = 0; i < pickSamples; i++) {
      const decay = 1 - i / pickSamples;
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    const pickSrc = this.#context.createBufferSource();
    const pickGain = this.#context.createGain();
    pickSrc.buffer = pick;
    pickGain.gain.value = 0.14;
    pickSrc.connect(pickGain);
    pickGain.connect(this.#simGain);
    pickSrc.start(t);
    pickSrc.stop(t + 0.02);
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

  /**
   * @param {number} frequency
   * @param {{ pluck?: boolean }} [options]
   */
  setSimulatedFrequency(frequency, options = {}) {
    this.#setPartialFrequencies(frequency);
    if (options.pluck !== false) {
      this.#triggerSimPluck();
    }
  }

  /** Low open E (~82 Hz) is hard to hear on phone speakers — boost monitor level. */
  static #monitorLevelForFrequency(frequency) {
    if (frequency < 95) {
      return 0.48;
    }
    if (frequency < 130) {
      return 0.32;
    }
    return 0.22;
  }

  stop() {
    if (this.#analysisOsc) {
      try {
        this.#analysisOsc.stop();
      } catch {
        /* already stopped */
      }
      this.#analysisOsc.disconnect();
    }
    this.#analysisGain?.disconnect();
    this.#analysisOsc = null;
    this.#analysisGain = null;

    for (const { osc, level } of this.#simPartials) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      osc.disconnect();
      level.disconnect();
    }
    this.#simPartials = [];
    this.#simToneFilter?.disconnect();
    this.#simGain?.disconnect();
    this.#monitorGain?.disconnect();
    this.#simGain = null;
    this.#monitorGain = null;
    this.#simToneFilter = null;
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
    if (energy < 1e-8) {
      return null;
    }

    let bestOffset = -1;
    let bestCorr = 0;

    for (let offset = minPeriod; offset <= maxPeriod; offset++) {
      let corr = 0;
      for (let i = 0; i < size - offset; i++) {
        corr += samples[i] * samples[i + offset];
      }
      corr /= size - offset;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = offset;
      }
    }

    if (bestOffset <= 0) {
      return null;
    }

    const frequency = sampleRate / bestOffset;
    const confidence = Math.min(1, Math.max(0, bestCorr / (energy / size + 1e-8)));

    if (frequency < MIN_FREQ || frequency > MAX_FREQ) {
      return null;
    }

    return { frequency, confidence };
  }
}
