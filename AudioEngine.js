const FFT_SIZE = 2048;
const BANDPASS_FREQ = 440;
const BANDPASS_Q = 1.0;
const RMS_GATE = 0.015;
const MIN_FREQ = 70;
const MAX_FREQ = 420;

/** Open-string samples at standard tuning (Hz) — playbackRate scales detune in demo. */
const GUITAR_SAMPLE_DEFS = {
  E2: { url: "/samples/guitar/e2.wav", refHz: 82.41 },
  A2: { url: "/samples/guitar/a2.wav", refHz: 110.0 },
  D3: { url: "/samples/guitar/d3.wav", refHz: 146.83 },
  G3: { url: "/samples/guitar/g3.wav", refHz: 196.0 },
  B3: { url: "/samples/guitar/b3.wav", refHz: 246.94 },
  E4: { url: "/samples/guitar/e4.wav", refHz: 329.63 },
};

/** @type {Promise<Map<string, ArrayBuffer>> | null} */
let guitarSampleBytesPromise = null;

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
  #monitorGain = null;
  /** @type {BiquadFilterNode | null} */
  #simToneFilter = null;
  /** @type {BiquadFilterNode | null} */
  #demoBodyFilter = null;
  /** Steady fundamental for analyser — not affected by pluck envelope. */
  /** @type {OscillatorNode | null} */
  #analysisOsc = null;
  /** @type {GainNode | null} */
  #analysisGain = null;
  /** @type {Map<string, AudioBuffer> | null} */
  #guitarSamples = null;
  /** @type {string} */
  #simStringId = "G3";
  /** @type {AudioBufferSourceNode[]} */
  #activeSampleSources = [];
  /** Realistic plucks — only for Play tuner demo, not mic or dev simulate. */
  /** @type {boolean} */
  #playDemoAudio = false;

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
   * @param {{ simulate?: boolean, frequency?: number, stringId?: string, playDemoAudio?: boolean }} [options]
   */
  async start(options = {}) {
    if (this.isRunning) {
      return;
    }

    const simulate = options.simulate === true;
    const frequency = options.frequency ?? 196;
    const stringId = options.stringId ?? "G3";
    this.#playDemoAudio = options.playDemoAudio === true;

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
      if (this.#playDemoAudio) {
        this.#guitarSamples = await AudioEngine.#loadGuitarSamples(this.#context);
      }
      this.#simStringId = stringId in GUITAR_SAMPLE_DEFS ? stringId : "G3";
      this.#buildSimulatedGuitarGraph(frequency, this.#playDemoAudio);
      if (this.#playDemoAudio) {
        this.#triggerSimPluck(frequency, this.#simStringId);
      }
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

  /** @param {AudioContext} context */
  static async #loadGuitarSamples(context) {
    if (!guitarSampleBytesPromise) {
      guitarSampleBytesPromise = (async () => {
        /** @type {Map<string, ArrayBuffer>} */
        const map = new Map();
        await Promise.all(
          Object.entries(GUITAR_SAMPLE_DEFS).map(async ([id, def]) => {
            const res = await fetch(def.url);
            if (!res.ok) {
              throw new Error(`Failed to load guitar sample ${id}: ${res.status}`);
            }
            map.set(id, await res.arrayBuffer());
          }),
        );
        return map;
      })();
    }
    const bytes = await guitarSampleBytesPromise;
    /** @type {Map<string, AudioBuffer>} */
    const decoded = new Map();
    for (const [id, data] of bytes) {
      decoded.set(id, await context.decodeAudioData(data.slice(0)));
    }
    return decoded;
  }

  /**
   * @param {number} fundamentalHz
   * @param {boolean} withSpeakerMonitor
   */
  #buildSimulatedGuitarGraph(fundamentalHz, withSpeakerMonitor) {
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

    if (!withSpeakerMonitor) {
      return;
    }

    const body = this.#context.createBiquadFilter();
    body.type = "peaking";
    body.frequency.value = 280;
    body.Q.value = 0.85;
    body.gain.value = 5;

    this.#simToneFilter = this.#context.createBiquadFilter();
    this.#simToneFilter.type = "lowpass";
    this.#simToneFilter.frequency.value = 7200;
    this.#simToneFilter.Q.value = 0.35;

    this.#monitorGain = this.#context.createGain();
    this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(fundamentalHz);
    body.connect(this.#simToneFilter);
    this.#simToneFilter.connect(this.#monitorGain);
    this.#monitorGain.connect(this.#context.destination);
    this.#demoBodyFilter = body;
  }

  /** @param {number} fundamentalHz */
  #setAnalysisFrequency(fundamentalHz) {
    if (this.#analysisOsc) {
      this.#analysisOsc.frequency.value = fundamentalHz;
    }
    if (this.#monitorGain) {
      this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(fundamentalHz);
    }
  }

  /**
   * @param {number} frequency
   * @param {string} stringId
   */
  #stopActiveSamples() {
    for (const src of this.#activeSampleSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.#activeSampleSources = [];
  }

  /**
   * @param {number} frequency
   * @param {string} stringId
   */
  #triggerSimPluck(frequency, stringId) {
    if (!this.#playDemoAudio || !this.#context || !this.#simToneFilter || !this.#guitarSamples) {
      return;
    }

    const def = GUITAR_SAMPLE_DEFS[stringId] ?? GUITAR_SAMPLE_DEFS.G3;
    const buffer = this.#guitarSamples.get(stringId) ?? this.#guitarSamples.get("G3");
    if (!buffer) {
      return;
    }

    this.#stopActiveSamples();

    const t = this.#context.currentTime;
    const playbackRate = frequency / def.refHz;
    const src = this.#context.createBufferSource();
    const gain = this.#context.createGain();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;
    gain.gain.value = 0.92;
    src.connect(gain);
    const monitorIn = this.#demoBodyFilter ?? this.#simToneFilter;
    gain.connect(monitorIn);
    src.start(t);
    const pluckSec = Math.min(buffer.duration / playbackRate, 1.25);
    src.stop(t + pluckSec);
    this.#activeSampleSources.push(src);
    src.onended = () => {
      this.#activeSampleSources = this.#activeSampleSources.filter((node) => node !== src);
    };
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
    const stringId =
      options.stringId && options.stringId in GUITAR_SAMPLE_DEFS
        ? options.stringId
        : this.#simStringId;
    this.#simStringId = stringId;
    this.#setAnalysisFrequency(frequency);
    if (options.pluck !== false && this.#playDemoAudio) {
      this.#triggerSimPluck(frequency, stringId);
    }
  }

  /** Mute demo plucks when leaving Play tuner demo (simulate needle can stay live). */
  setPlayDemoAudio(enabled) {
    this.#playDemoAudio = enabled;
    if (!enabled) {
      this.#stopActiveSamples();
      if (this.#monitorGain) {
        this.#monitorGain.gain.value = 0;
      }
    } else if (this.#monitorGain && this.#analysisOsc) {
      this.#monitorGain.gain.value = AudioEngine.#monitorLevelForFrequency(
        this.#analysisOsc.frequency.value,
      );
    }
  }

  /** Low open E (~82 Hz) is hard to hear on phone speakers — boost monitor level. */
  static #monitorLevelForFrequency(frequency) {
    if (frequency < 95) {
      return 0.55;
    }
    if (frequency < 130) {
      return 0.38;
    }
    return 0.28;
  }

  stop() {
    this.#stopActiveSamples();
    this.#playDemoAudio = false;

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

    this.#demoBodyFilter?.disconnect();
    this.#simToneFilter?.disconnect();
    this.#monitorGain?.disconnect();
    this.#demoBodyFilter = null;
    this.#monitorGain = null;
    this.#simToneFilter = null;
    this.#guitarSamples = null;
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
