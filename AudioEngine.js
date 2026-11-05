const FFT_SIZE = 2048;
const BANDPASS_FREQ = 440;
const BANDPASS_Q = 1.0;
const RMS_GATE = 0.015;
const MIN_FREQ = 70;
const MAX_FREQ = 420;

/** Brief resonator mix — reads as a pluck, not a held note. */
const DEMO_PLUCK_PARTIALS = [
  { ratio: 1, gain: 1, q: 16 },
  { ratio: 2, gain: 0.48, q: 11 },
  { ratio: 3, gain: 0.22, q: 8 },
  { ratio: 4, gain: 0.1, q: 6 },
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
  /** @type {string} */
  #simStringId = "G3";
  /** @type {number} */
  #simMonitorFrequency = 196;
  /** Nodes to tear down after each demo pluck. */
  /** @type {{ stop?: () => void, disconnect: () => void }[]} */
  #activeDemoNodes = [];
  /** Realistic plucks — only for Play tuner demo, not mic or dev simulate. */
  /** @type {boolean} */
  #playDemoAudio = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #demoTeardownTimer = null;

  get isRunning() {
    return (
      this.#context?.state === "running" &&
      (this.#stream != null || this.#simulateMode)
    );
  }

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
   * @param {{ simulate?: boolean, frequency?: number, stringId?: string, playDemoAudio?: boolean }} [options]
   */
  async start(options = {}) {
    if (this.isRunning) {
      return;
    }

    const simulate = options.simulate === true;
    const stringId = options.stringId ?? "G3";
    this.#playDemoAudio = options.playDemoAudio === true;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.#context = new AudioCtx();
    this.#simulateMode = simulate;
    this.#simStringId = stringId in { E2: 1, A2: 1, D3: 1, G3: 1, B3: 1, E4: 1 } ? stringId : "G3";
    this.#simMonitorFrequency = options.frequency ?? 196;

    this.#bandpass = this.#context.createBiquadFilter();
    this.#bandpass.type = "bandpass";
    this.#bandpass.frequency.value = BANDPASS_FREQ;
    this.#bandpass.Q.value = BANDPASS_Q;

    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = FFT_SIZE;
    this.#analyser.smoothingTimeConstant = 0;
    this.#timeBuffer = new Float32Array(this.#analyser.fftSize);

    if (simulate) {
      /* Demo/sim: UI drives cents — no mic, no speaker graph until a pluck. */
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

  #clearDemoTeardownTimer() {
    if (this.#demoTeardownTimer != null) {
      clearTimeout(this.#demoTeardownTimer);
      this.#demoTeardownTimer = null;
    }
  }

  #tearDownDemoPluck() {
    this.#clearDemoTeardownTimer();
    for (const node of this.#activeDemoNodes) {
      try {
        node.stop?.();
      } catch {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.#activeDemoNodes = [];
  }

  /**
   * One-shot pluck: speakers connected only for ~0.35 s, then fully disconnected.
   * @param {number} frequency
   */
  #triggerDemoPluck(frequency) {
    if (!this.#playDemoAudio || !this.#context) {
      return;
    }

    this.#tearDownDemoPluck();

    const ctx = this.#context;
    const t = ctx.currentTime;
    const sr = ctx.sampleRate;
    const level = AudioEngine.#monitorLevelForFrequency(frequency);

    const pickLen = Math.max(1, Math.floor(sr * 0.0035));
    const pickBuf = ctx.createBuffer(1, pickLen, sr);
    const pickData = pickBuf.getChannelData(0);
    for (let i = 0; i < pickLen; i++) {
      pickData[i] = (Math.random() * 2 - 1) * (1 - i / pickLen);
    }

    const pick = ctx.createBufferSource();
    pick.buffer = pickBuf;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(level, t + 0.002);
    master.gain.exponentialRampToValueAtTime(level * 0.28, t + 0.045);
    master.gain.setTargetAtTime(0.0001, t + 0.045, 0.065);

    const click = ctx.createGain();
    click.gain.value = 0.12;
    pick.connect(click);
    click.connect(master);

    /** @type {AudioNode[]} */
    const pluckNodes = [pick, master, click];

    for (const partial of DEMO_PLUCK_PARTIALS) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = frequency * partial.ratio;
      bp.Q.value = partial.q;
      const partialGain = ctx.createGain();
      partialGain.gain.value = partial.gain * 0.2;
      pick.connect(bp);
      bp.connect(partialGain);
      partialGain.connect(master);
      pluckNodes.push(bp, partialGain);
    }

    const bright = ctx.createBiquadFilter();
    bright.type = "lowpass";
    bright.frequency.value = Math.min(5200, frequency * 9);
    bright.Q.value = 0.35;
    master.connect(bright);
    bright.connect(ctx.destination);
    pluckNodes.push(bright);

    pick.start(t);
    pick.stop(t + 0.02);

    this.#activeDemoNodes = pluckNodes.map((node) => ({
      stop: node instanceof AudioBufferSourceNode ? () => node.stop() : undefined,
      disconnect: () => node.disconnect(),
    }));

    const endSec = 0.38;
    this.#demoTeardownTimer = setTimeout(() => {
      this.#tearDownDemoPluck();
    }, endSec * 1000);
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
   * @param {{ pluck?: boolean, stringId?: string }} [options]
   */
  setSimulatedFrequency(frequency, options = {}) {
    if (options.stringId && options.stringId in { E2: 1, A2: 1, D3: 1, G3: 1, B3: 1, E4: 1 }) {
      this.#simStringId = options.stringId;
    }
    this.#simMonitorFrequency = frequency;
    if (options.pluck !== false && this.#playDemoAudio) {
      this.#triggerDemoPluck(frequency);
    }
  }

  setPlayDemoAudio(enabled) {
    this.#playDemoAudio = enabled;
    if (!enabled) {
      this.#tearDownDemoPluck();
    }
  }

  static #monitorLevelForFrequency(frequency) {
    if (frequency < 95) {
      return 0.62;
    }
    if (frequency < 130) {
      return 0.42;
    }
    return 0.32;
  }

  stop() {
    this.#tearDownDemoPluck();
    this.#playDemoAudio = false;
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

  readTimeDomainBuffer() {
    if (!this.#analyser || !this.#timeBuffer) {
      return null;
    }
    this.#analyser.getFloatTimeDomainData(this.#timeBuffer);
    return this.#timeBuffer;
  }

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

  static computeRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples.length);
  }

  static #downsample(samples, factor) {
    const len = Math.floor(samples.length / factor);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = samples[i * factor];
    }
    return out;
  }

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
