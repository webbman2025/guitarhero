import { AudioEngine } from "./AudioEngine.js";

/** Standard-tuning target frequencies (Hz). */
export const GUITAR_STRINGS = [
  { id: "E2", letter: "E", hz: 82.41 },
  { id: "A2", letter: "A", hz: 110.0 },
  { id: "D3", letter: "D", hz: 146.83 },
  { id: "G3", letter: "G", hz: 196.0 },
  { id: "B3", letter: "B", hz: 246.94 },
  { id: "E4", letter: "E", hz: 329.63 },
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** 7-segment patterns for note letters (voice / chromatic display). */
const SEGMENT_LETTERS = {
  A: ["a", "b", "c", "e", "f", "g"],
  B: ["a", "b", "c", "d", "e", "f", "g"],
  C: ["a", "d", "e", "f"],
  D: ["b", "c", "d", "e", "g"],
  E: ["a", "d", "e", "f", "g"],
  F: ["a", "e", "f", "g"],
  G: ["a", "c", "d", "e", "f", "g"],
};

const CONFIDENCE_MIN = 0.9;
const DEV_VOICE_CONFIDENCE_MIN = 0.45;
const IN_TUNE_CENTS = 3;
const NEEDLE_MIN = -45;
const NEEDLE_MAX = 45;
const CENTS_SPAN = 50;
const NEEDLE_PIVOT_X = 195;
const NEEDLE_PIVOT_Y = 168;
const GAUGE_RADIUS = 147;
const MIC_GRANTED_STORAGE_KEY = "guitar_tuner_mic_granted";

/** Sim/demo: repeated taps on the same string move toward in tune. */
const SIM_TAP_CENTS = [-16, -7, 0];

export class UIController {
  /** @type {AudioEngine} */
  #engine = new AudioEngine();
  /** @type {number} */
  #rafId = 0;
  /** @type {number} */
  #needleTargetDeg = NEEDLE_MIN;
  /** @type {number} */
  #needleDeg = NEEDLE_MIN;
  /** @type {string} */
  #selectedStringId = "G3";
  /** @type {boolean} */
  #manualString = false;
  /** @type {boolean} */
  #devOpen = false;
  /** @type {boolean} */
  #devSimulate = false;
  /** @type {"guitar" | "voice"} */
  #tuningMode = "guitar";
  /** @type {number} */
  #devSimCents = 0;
  /** @type {boolean} */
  #resumeAfterBackground = false;
  /** @type {boolean} */
  #devDemoActive = false;
  /** @type {string | null} */
  #lastSimTapStringId = null;
  /** @type {number} */
  #simTapPhaseIndex = 0;

  /**
   * @param {{
   *   overlay: HTMLElement,
   *   overlayBtn: HTMLButtonElement,
   *   overlayHint: HTMLElement,
   *   appMain: HTMLElement,
   *   stopBtn: HTMLButtonElement,
   *   devToggle: HTMLButtonElement,
   *   devPanel: HTMLElement,
   *   devBackdrop: HTMLElement,
   *   devDoneBtn: HTMLButtonElement,
   *   devCurrentMode: HTMLElement,
   *   devExtra: HTMLElement,
   *   devSimulateBtn: HTMLButtonElement,
   *   devDemoBtn: HTMLButtonElement,
   *   devSimCents: HTMLInputElement,
   *   modeButtons: HTMLButtonElement[],
   *   devSimCentsOut: HTMLOutputElement,
   *   devReadout: HTMLElement,
   *   noteDisplay: HTMLElement,
   *   segElements: SVGRectElement[],
   *   centsLabel: HTMLElement,
   *   statusLabel: HTMLElement,
   *   needleWrap: SVGGElement,
   *   ticksGroup: SVGGElement,
   *   stringButtons: HTMLButtonElement[],
   * }} dom
   */
  constructor(dom) {
    this.dom = dom;
    this.#buildGaugeTicks(dom.ticksGroup);
    this.#setNeedleTransform(NEEDLE_MIN);
    this.#hideNoteDisplay();
    document.body.classList.add("mode-guitar");
    this.#bindEvents();
    void this.#bootstrap();
  }

  #bindEvents() {
    this.dom.devToggle.addEventListener("click", () => {
      if (this.#devOpen) {
        this.#closeDevMenu();
      } else {
        this.#openDevMenu();
      }
    });

    this.dom.devBackdrop.addEventListener("click", () => {
      this.#closeDevMenu();
    });

    this.dom.devDoneBtn.addEventListener("click", () => {
      this.#closeDevMenu();
    });

    this.dom.devSimulateBtn.addEventListener("click", () => {
      const enabled = this.dom.devSimulateBtn.getAttribute("aria-pressed") !== "true";
      if (!enabled) {
        this.#stopDevDemo();
      }
      this.#setSimulateEnabled(enabled);
      if (this.#engine.isRunning) {
        void this.#restartAudio();
      }
    });

    this.dom.devDemoBtn.addEventListener("click", () => {
      void this.#toggleDevDemo();
    });

    for (const btn of this.dom.modeButtons) {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (mode === "guitar" || mode === "voice") {
          this.#setTuningMode(mode);
        }
      });
    }

    this.dom.devSimCents.addEventListener("input", () => {
      if (this.#devDemoActive) {
        this.#stopDevDemo();
      }
      this.#devSimCents = Number(this.dom.devSimCents.value);
      this.dom.devSimCentsOut.textContent = String(this.#devSimCents);
      this.#applySimFrequency();
    });

    this.dom.overlayBtn.addEventListener("click", () => {
      void this.#onStartTap();
    });

    this.dom.stopBtn.addEventListener("click", () => {
      this.#shutdown();
    });

    for (const btn of this.dom.stringButtons) {
      btn.addEventListener("click", () => {
        void this.#onStringButtonTap(btn.getAttribute("data-string"));
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        void this.#pauseForBackground();
      } else {
        void this.#resumeFromBackground();
      }
    });

    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        void this.#resumeFromBackground();
      }
    });
  }

  async #micLooksGranted() {
    if (localStorage.getItem(MIC_GRANTED_STORAGE_KEY) === "1") {
      return true;
    }
    if (!navigator.permissions?.query) {
      return false;
    }
    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      return status.state === "granted";
    } catch {
      return false;
    }
  }

  async #watchMicPermission() {
    if (!navigator.permissions?.query) {
      return;
    }
    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      status.onchange = () => {
        void this.#onMicPermissionChange(status.state);
      };
    } catch {
      /* Permissions API unsupported for microphone */
    }
  }

  async #bootstrap() {
    await this.#watchMicPermission();
    if (await this.#shouldAutoStart()) {
      this.#prepareAutoStartUi();
      if (await this.#tryStartTuner()) {
        return;
      }
      this.#cancelAutoStartUi();
    }
    this.#revealStartOverlay();
    await this.#syncStartOverlayCopy();
  }

  /** Mic already allowed — skip "Tap to start" flash while getUserMedia runs. */
  #prepareAutoStartUi() {
    document.documentElement.classList.add("mic-granted-boot");
    this.dom.overlay.classList.add("start-overlay--hidden");
    this.dom.appMain.setAttribute("aria-hidden", "false");
    this.dom.appMain.classList.add("tuner--live");
  }

  #cancelAutoStartUi() {
    document.documentElement.classList.remove("mic-granted-boot");
    this.dom.appMain.classList.remove("tuner--live");
    this.dom.appMain.setAttribute("aria-hidden", "true");
    this.dom.stopBtn.hidden = true;
  }

  async #shouldAutoStart() {
    return !this.#devSimulate && (await this.#micLooksGranted());
  }

  async #onMicPermissionChange(state) {
    if (state !== "granted") {
      return;
    }
    if (this.dom.appMain.classList.contains("tuner--live")) {
      return;
    }
    this.#prepareAutoStartUi();
    if (await this.#tryStartTuner()) {
      return;
    }
    this.#cancelAutoStartUi();
    this.#revealStartOverlay();
    await this.#syncStartOverlayCopy();
  }

  #revealStartOverlay() {
    document.documentElement.classList.remove("mic-granted-boot");
    this.dom.overlay.classList.remove("start-overlay--hidden");
  }

  async #syncStartOverlayCopy() {
    if (this.#devSimulate) {
      this.dom.overlayBtn.textContent = "Tap to start (simulated)";
      this.dom.overlayHint.hidden = true;
      this.dom.overlayHint.textContent = "";
      return;
    }
    const granted = await this.#micLooksGranted();
    if (granted) {
      this.dom.overlayBtn.textContent = "Tap to continue";
      this.dom.overlayHint.hidden = true;
      this.dom.overlayHint.textContent = "";
    } else {
      this.dom.overlayBtn.textContent = "Tap to Start Tuner";
      this.dom.overlayHint.hidden = false;
      this.dom.overlayHint.textContent =
        "First time only: your browser will ask to use the microphone. Choose Allow.";
    }
  }

  #rememberMicGranted() {
    if (!this.#devSimulate) {
      localStorage.setItem(MIC_GRANTED_STORAGE_KEY, "1");
    }
  }

  async #pauseForBackground() {
    if (!this.#engine.hasActiveSession || !this.dom.appMain.classList.contains("tuner--live")) {
      return;
    }
    this.#resumeAfterBackground = true;
    cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
    await this.#engine.suspend();
  }

  async #resumeFromBackground() {
    if (!this.#resumeAfterBackground || !this.#engine.hasActiveSession) {
      return;
    }
    if (!this.dom.appMain.classList.contains("tuner--live")) {
      this.#resumeAfterBackground = false;
      return;
    }
    try {
      await this.#engine.resume();
      this.#resumeAfterBackground = false;
      if (!this.#rafId) {
        this.#rafId = requestAnimationFrame(() => this.#frame());
      }
    } catch (err) {
      console.error(err);
      this.#resumeAfterBackground = false;
      this.#shutdown();
    }
  }

  async #tryStartTuner() {
    try {
      await this.#startTunerCore();
      return true;
    } catch (err) {
      console.error(err);
      if (this.#engine.hasActiveSession) {
        this.#engine.stop();
      }
      return false;
    }
  }

  async #startTunerCore() {
    this.#manualString = false;
    await this.#engine.start({
      simulate: this.#devSimulate,
      frequency: this.#simFrequencyForSelectedString(),
    });
    this.#enterLiveMode();
    this.#rememberMicGranted();
    document.documentElement.classList.add("mic-granted-boot");
  }

  #enterLiveMode() {
    this.dom.overlay.classList.add("start-overlay--hidden");
    this.dom.appMain.setAttribute("aria-hidden", "false");
    this.dom.appMain.classList.add("tuner--live");
    this.dom.stopBtn.hidden = false;
    this.dom.statusLabel.textContent = "";
    if (!this.#rafId) {
      this.#rafId = requestAnimationFrame(() => this.#frame());
    }
  }

  async #onStartTap() {
    this.#revealStartOverlay();
    if (await this.#tryStartTuner()) {
      return;
    }
    this.dom.overlayBtn.textContent = this.#devSimulate
      ? "Audio failed — try again"
      : "Microphone blocked — try again";
    this.dom.overlayHint.hidden = false;
    this.dom.overlayHint.textContent = this.#devSimulate
      ? ""
      : "Check Settings → your browser → Microphone, then try again.";
  }

  async #restartAudio() {
    const wasLive = this.#engine.isRunning;
    this.#engine.stop();
    if (!wasLive) {
      return;
    }
    try {
      await this.#engine.start({
        simulate: this.#devSimulate,
        frequency: this.#simFrequencyForSelectedString(),
      });
    } catch (err) {
      console.error(err);
      this.#updateDevReadout("Restart failed — tap Stop then Start");
    }
  }

  #simFrequencyForSelectedString() {
    const target = GUITAR_STRINGS.find((s) => s.id === this.#selectedStringId) ?? GUITAR_STRINGS[3];
    return target.hz * 2 ** (this.#devSimCents / 1200);
  }

  #applySimFrequency() {
    if (this.#engine.simulateMode) {
      this.#engine.setSimulatedFrequency(this.#simFrequencyForSelectedString(), { pluck: true });
    }
  }

  #shutdown() {
    this.#stopDevDemo();
    this.#resumeAfterBackground = false;
    this.#engine.stop();
    cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
    this.#needleTargetDeg = NEEDLE_MIN;
    this.#needleDeg = NEEDLE_MIN;
    this.#setNeedleTransform(NEEDLE_MIN);
    this.#clearLivePitch("");
    this.dom.overlay.classList.remove("start-overlay--hidden");
    this.dom.appMain.setAttribute("aria-hidden", "true");
    this.dom.appMain.classList.remove("tuner--live");
    this.dom.stopBtn.hidden = true;
    this.#revealStartOverlay();
    void this.#syncStartOverlayCopy();
    this.#setPerfectFeedback(false);
    this.#hideNoteDisplay();
  }

  #frame() {
    if (this.#engine.isRunning) {
      const voiceMode = this.#isVoiceMode();
      const simMode = this.#engine.simulateMode;

      if (simMode && !voiceMode) {
        const target =
          GUITAR_STRINGS.find((s) => s.id === this.#selectedStringId) ?? GUITAR_STRINGS[3];
        this.#applyTuningFromCents(target, this.#devSimCents, { allowPerfect: true });
        if (this.#devOpen) {
          const freq = this.#simFrequencyForSelectedString();
          this.dom.devReadout.textContent =
            `Demo · ${target.letter} (${target.id})\n` +
            `${freq.toFixed(2)} Hz · needle at ${this.#devSimCents > 0 ? "+" : ""}${this.#devSimCents}¢`;
        }
      } else {
        const buffer = this.#engine.readTimeDomainBuffer();
        if (buffer) {
          const result = this.#engine.detectPitch(buffer, {
            relaxGates: voiceMode,
          });
          if (this.#devOpen) {
            this.#updateDevReadoutFromResult(result, buffer);
          }

          if (result === false) {
            this.#clearLivePitch(voiceMode ? "Voice: too quiet" : "");
          } else if (result.confidence < CONFIDENCE_MIN) {
            if (voiceMode && result.confidence >= DEV_VOICE_CONFIDENCE_MIN) {
              this.#applyChromaticPitch(result.frequency, {
                allowPerfect: false,
              });
            } else {
              this.#clearLivePitch(voiceMode ? "Voice: keep humming…" : "");
            }
          } else if (voiceMode) {
            this.#applyChromaticPitch(result.frequency, { allowPerfect: true });
          } else {
            this.#applyTuning(result.frequency, { allowPerfect: true });
          }
        }
      }
    }

    this.#smoothNeedle();
    this.#rafId = requestAnimationFrame(() => this.#frame());
  }

  /** Reset needle to center and clear live pitch readout. */
  #clearLivePitch(statusText) {
    this.#needleTargetDeg = NEEDLE_MIN;
    this.dom.statusLabel.textContent = statusText;
    this.dom.centsLabel.textContent = "—";
    this.dom.centsLabel.classList.remove("tuner__cents--perfect");
    this.#setPerfectFeedback(false);
    this.#hideNoteDisplay();
  }

  #isVoiceMode() {
    return this.#tuningMode === "voice" && !this.#engine.simulateMode;
  }

  #openDevMenu() {
    this.#devOpen = true;
    this.dom.devPanel.hidden = false;
    this.dom.devBackdrop.hidden = false;
    this.dom.devBackdrop.setAttribute("aria-hidden", "false");
    this.dom.devToggle.classList.add("dev-toggle--open");
    this.dom.devToggle.setAttribute("aria-expanded", "true");
    this.#syncDevMenuUi();
  }

  #closeDevMenu() {
    this.#devOpen = false;
    this.dom.devPanel.hidden = true;
    this.dom.devBackdrop.hidden = true;
    this.dom.devBackdrop.setAttribute("aria-hidden", "true");
    this.dom.devToggle.classList.remove("dev-toggle--open");
    this.dom.devToggle.setAttribute("aria-expanded", "false");
  }

  #syncDevMenuUi() {
    this.#updateDevModeLabel();
    this.dom.devExtra.hidden = !this.#devSimulate;
  }

  /** @param {boolean} enabled */
  #setSimulateEnabled(enabled) {
    if (!enabled) {
      this.#stopDevDemo();
    }
    this.#devSimulate = enabled;
    this.dom.devSimulateBtn.setAttribute("aria-pressed", String(enabled));
    this.dom.devExtra.hidden = !enabled;
    if (!this.dom.appMain.classList.contains("tuner--live")) {
      void this.#syncStartOverlayCopy();
    }
  }

  #syncDevDemoBtn() {
    this.dom.devDemoBtn.setAttribute("aria-pressed", String(this.#devDemoActive));
    this.dom.devDemoBtn.textContent = this.#devDemoActive
      ? "Stop tuner demo"
      : "Play tuner demo (tap strings)";
    this.dom.devDemoBtn.classList.toggle("dev-menu__item--active", this.#devDemoActive);
  }

  #stopDevDemo() {
    this.#devDemoActive = false;
    this.#syncDevDemoBtn();
  }

  async #toggleDevDemo() {
    if (this.#devDemoActive) {
      this.#stopDevDemo();
      return;
    }

    this.#setTuningMode("guitar");
    this.#setSimulateEnabled(true);
    if (!this.dom.appMain.classList.contains("tuner--live")) {
      if (!(await this.#tryStartTuner())) {
        this.dom.devReadout.textContent = "Demo needs audio — tap Start on the main screen, then try again.";
        return;
      }
    } else {
      await this.#restartAudio();
    }

    this.#devDemoActive = true;
    this.#lastSimTapStringId = null;
    this.#simTapPhaseIndex = 0;
    this.#syncDevDemoBtn();
    this.#closeDevMenu();
    void this.#onStringButtonTap(this.#selectedStringId);
    this.dom.devReadout.textContent =
      "Demo — tap the same letter 3 times: flat → closer → PERFECT.\nEach string (E, A, D, G, B, E) works the same way.";
  }

  /** @param {string | null} stringId */
  #applySimTapPhase(stringId) {
    if (this.#lastSimTapStringId === stringId) {
      if (this.#simTapPhaseIndex >= SIM_TAP_CENTS.length - 1) {
        this.#simTapPhaseIndex = 0;
      } else {
        this.#simTapPhaseIndex += 1;
      }
    } else {
      this.#lastSimTapStringId = stringId;
      this.#simTapPhaseIndex = 0;
    }
    this.#devSimCents = SIM_TAP_CENTS[this.#simTapPhaseIndex];
    this.dom.devSimCents.value = String(this.#devSimCents);
    this.dom.devSimCentsOut.textContent = String(this.#devSimCents);
  }

  /** @param {string | null} stringId */
  async #onStringButtonTap(stringId) {
    if (!stringId) {
      return;
    }

    this.#selectedStringId = stringId;
    this.#manualString = true;
    this.#setActiveStringButton(stringId);

    if (this.#devSimulate || this.#devDemoActive) {
      this.#applySimTapPhase(stringId);
    }

    if (this.#devSimulate && !this.#engine.isRunning) {
      if (!(await this.#tryStartTuner())) {
        return;
      }
    }

    this.#applySimFrequency();

    if (this.#engine.simulateMode) {
      const target =
        GUITAR_STRINGS.find((s) => s.id === stringId) ?? GUITAR_STRINGS[3];
      this.#applyTuningFromCents(target, this.#devSimCents, { allowPerfect: true });
    }

    if (this.#devOpen && (this.#devSimulate || this.#devDemoActive)) {
      const s = GUITAR_STRINGS.find((g) => g.id === stringId);
      if (s) {
        const cents = this.#devSimCents;
        const tapsLeft = SIM_TAP_CENTS.length - 1 - this.#simTapPhaseIndex;
        const hint =
          cents === 0
            ? "PERFECT — tap this letter again to start from flat"
            : `${tapsLeft} more tap${tapsLeft === 1 ? "" : "s"} on this letter for PERFECT`;
        this.dom.devReadout.textContent =
          `${s.letter} (${s.id}) · ${s.hz.toFixed(1)} Hz\n` +
          `Sim: ${cents > 0 ? "+" : ""}${cents}¢ — ${hint}`;
      }
    }
  }

  /** @param {"guitar" | "voice"} mode */
  #setTuningMode(mode) {
    this.#tuningMode = mode;
    this.dom.appMain.classList.toggle("tuner--guitar", mode === "guitar");
    this.dom.appMain.classList.toggle("tuner--voice", mode === "voice");
    document.body.classList.toggle("mode-guitar", mode === "guitar");
    document.body.classList.toggle("mode-voice", mode === "voice");
    for (const btn of this.dom.modeButtons) {
      btn.classList.toggle("dev-menu__item--active", btn.getAttribute("data-mode") === mode);
    }
    this.#updateDevModeLabel();
    this.#clearLivePitch("");
  }

  #updateDevModeLabel() {
    const labels = {
      guitar: "Current: Guitar tuning",
      voice: "Current: Voice test",
    };
    this.dom.devCurrentMode.textContent = labels[this.#tuningMode];
  }

  /** @param {string} message */
  #updateDevReadout(message) {
    if (!this.#devOpen) {
      return;
    }
    this.dom.devReadout.textContent = message;
  }

  /**
   * @param {false | { frequency: number, confidence: number, rms: number }} result
   * @param {Float32Array} buffer
   */
  #updateDevReadoutFromResult(result, buffer) {
    const rms = AudioEngine.computeRms(buffer);
    const mode = this.#engine.simulateMode ? "simulate" : "mic";
    if (result === false) {
      this.dom.devReadout.textContent =
        `mode: ${mode}\nrms: ${rms.toFixed(4)} (gate 0.015)\npitch: —\n` +
        (mode === "mic" ? "tip: hum one note steadily" : "tip: enable Simulate tone");
      return;
    }
    this.dom.devReadout.textContent =
      `mode: ${mode}\nrms: ${result.rms.toFixed(4)}\n` +
      `Hz: ${result.frequency.toFixed(2)}\nconf: ${result.confidence.toFixed(3)}`;
  }

  /**
   * Demo / sim: drive needle from exact cent offset (matches gauge teaching targets).
   * @param {{ id: string, letter: string, hz: number }} target
   * @param {number} cents
   * @param {{ allowPerfect?: boolean, statusHint?: string }} [options]
   */
  #applyTuningFromCents(target, cents, options = {}) {
    const allowPerfect = options.allowPerfect !== false;
    this.#needleTargetDeg = UIController.#centsToNeedleDegrees(cents);
    this.#needleDeg = this.#needleTargetDeg;
    this.#setNeedleTransform(this.#needleDeg);

    const inTune = Math.abs(cents) <= IN_TUNE_CENTS;
    const showPerfect = allowPerfect && inTune;
    this.#setSevenSegLetter(target.letter, true, showPerfect);

    if (options.statusHint) {
      this.dom.statusLabel.textContent = options.statusHint;
    } else if (showPerfect) {
      this.dom.statusLabel.textContent = "";
    } else {
      this.dom.statusLabel.textContent = cents > 0 ? "Sharp" : "Flat";
    }

    const rounded = Math.round(cents);
    const sign = rounded > 0 ? "+" : "";
    this.dom.centsLabel.classList.toggle("tuner__cents--perfect", showPerfect);
    this.dom.centsLabel.textContent = showPerfect ? "Perfect" : `${sign}${rounded}¢`;
    this.#setPerfectFeedback(showPerfect);
  }

  /** @param {number} degrees */
  #setNeedleTransform(degrees) {
    this.dom.needleWrap.setAttribute(
      "transform",
      `rotate(${degrees.toFixed(2)} ${NEEDLE_PIVOT_X} ${NEEDLE_PIVOT_Y})`,
    );
  }

  /**
   * @param {number} frequency
   * @param {{ allowPerfect?: boolean, statusHint?: string }} [options]
   */
  #applyTuning(frequency, options = {}) {
    const allowPerfect = options.allowPerfect !== false;
    let target = GUITAR_STRINGS.find((s) => s.id === this.#selectedStringId) ?? GUITAR_STRINGS[3];

    if (!this.#manualString) {
      target = UIController.#nearestString(frequency);
      this.#selectedStringId = target.id;
      this.#setActiveStringButton(target.id);
    }

    const cents = 1200 * Math.log2(frequency / target.hz);
    const needleDeg = UIController.#centsToNeedleDegrees(cents);
    this.#needleTargetDeg = needleDeg;

    const inTune = Math.abs(cents) <= IN_TUNE_CENTS;
    const showPerfect = allowPerfect && inTune;
    this.#setSevenSegLetter(target.letter, true, showPerfect);

    if (options.statusHint) {
      this.dom.statusLabel.textContent = options.statusHint;
    } else if (showPerfect) {
      this.dom.statusLabel.textContent = "";
    } else {
      this.dom.statusLabel.textContent = cents > 0 ? "Sharp" : "Flat";
    }

    const rounded = Math.round(cents);
    const sign = rounded > 0 ? "+" : "";
    this.dom.centsLabel.classList.toggle("tuner__cents--perfect", showPerfect);
    this.dom.centsLabel.textContent = showPerfect ? "Perfect" : `${sign}${rounded}¢`;
    this.#setPerfectFeedback(showPerfect);
  }

  /**
   * Chromatic frequency-checker style (voice dev / humming).
   * @param {number} frequency
   * @param {{ allowPerfect?: boolean }} [options]
   */
  #applyChromaticPitch(frequency, options = {}) {
    const allowPerfect = options.allowPerfect !== false;
    const N = 69 + 12 * Math.log2(frequency / 440);
    const nearestMidi = Math.round(N);
    const cents = 1200 * (N - nearestMidi);

    this.#needleTargetDeg = UIController.#centsToNeedleDegrees(cents);

    const noteName = NOTE_NAMES[((nearestMidi % 12) + 12) % 12];
    const octave = Math.floor(nearestMidi / 12) - 1;
    const letter = noteName.charAt(0);

    const inTune = Math.abs(cents) <= IN_TUNE_CENTS;
    const showPerfect = allowPerfect && inTune;
    this.#setSevenSegLetter(letter, true, showPerfect);

    const rounded = Math.round(cents);
    const sign = rounded > 0 ? "+" : "";
    this.dom.centsLabel.classList.toggle("tuner__cents--perfect", showPerfect);

    if (showPerfect) {
      this.dom.statusLabel.textContent = `${frequency.toFixed(1)} Hz · ${noteName}${octave}`;
      this.dom.centsLabel.textContent = "Perfect";
    } else {
      this.dom.statusLabel.textContent = `${frequency.toFixed(1)} Hz · ${noteName}${octave}`;
      this.dom.centsLabel.textContent = `${sign}${rounded}¢`;
    }
    this.#setPerfectFeedback(showPerfect);
  }

  /** Full-screen + gauge feedback when pitch is within ±IN_TUNE_CENTS. */
  #setPerfectFeedback(perfect) {
    document.body.classList.toggle("perfect-tune", perfect);
    this.dom.appMain.classList.toggle("tuner--perfect", perfect);
  }

  #hideNoteDisplay() {
    for (const segEl of this.dom.segElements) {
      segEl.classList.remove("seven-seg__seg--on");
    }
    this.dom.noteDisplay.classList.remove("seven-seg--in-tune", "seven-seg--active");
    this.dom.noteDisplay.classList.add("seven-seg--idle");
  }

  /**
   * @param {string} letter
   * @param {boolean} active
   * @param {boolean} inTune
   */
  #setSevenSegLetter(letter, active, inTune = false) {
    this.dom.noteDisplay.classList.remove("seven-seg--idle");
    const onSegments = SEGMENT_LETTERS[letter] ?? SEGMENT_LETTERS.G;
    for (const segEl of this.dom.segElements) {
      const id = segEl.getAttribute("data-seg");
      segEl.classList.toggle("seven-seg__seg--on", id != null && onSegments.includes(id));
    }
    this.dom.noteDisplay.classList.remove("seven-seg--in-tune", "seven-seg--active");
    if (active) {
      this.dom.noteDisplay.classList.add(inTune ? "seven-seg--in-tune" : "seven-seg--active");
    }
  }

  /** @param {number} frequency */
  static #nearestString(frequency) {
    let best = GUITAR_STRINGS[0];
    let bestAbsCents = Infinity;
    for (const string of GUITAR_STRINGS) {
      const cents = Math.abs(1200 * Math.log2(frequency / string.hz));
      if (cents < bestAbsCents) {
        bestAbsCents = cents;
        best = string;
      }
    }
    return best;
  }

  /** @param {number} cents */
  static #centsToNeedleDegrees(cents) {
    const clampedCents = Math.max(-CENTS_SPAN, Math.min(CENTS_SPAN, cents));
    const deg = (clampedCents / CENTS_SPAN) * NEEDLE_MAX;
    return Math.max(NEEDLE_MIN, Math.min(NEEDLE_MAX, deg));
  }

  #smoothNeedle() {
    if (!this.#engine.simulateMode) {
      this.#needleDeg += (this.#needleTargetDeg - this.#needleDeg) * 0.22;
    }
    this.#setNeedleTransform(this.#needleDeg);
  }

  /** @param {string} stringId */
  #setActiveStringButton(stringId) {
    for (const btn of this.dom.stringButtons) {
      btn.classList.toggle("tuner__string--active", btn.getAttribute("data-string") === stringId);
    }
  }

  /** @param {SVGGElement} svgTicksGroup */
  #buildGaugeTicks(svgTicksGroup, cx = NEEDLE_PIVOT_X, cy = NEEDLE_PIVOT_Y, radius = GAUGE_RADIUS) {
    const tickCount = 25;
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const angleDeg = -90 + t * 180;
      const angleRad = (angleDeg * Math.PI) / 180;
      const inner = radius - (i % 5 === 0 ? 12 : 7);
      const x1 = cx + inner * Math.cos(angleRad);
      const y1 = cy + inner * Math.sin(angleRad);
      const x2 = cx + radius * Math.cos(angleRad);
      const y2 = cy + radius * Math.sin(angleRad);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", i % 5 === 0 ? "gauge__tick gauge__tick--major" : "gauge__tick");
      svgTicksGroup.appendChild(line);
    }
  }
}

const overlay = document.getElementById("start-overlay");
const overlayBtn = document.getElementById("start-overlay-btn");
const overlayHint = document.getElementById("start-overlay-hint");
const appMain = document.getElementById("app-main");
const stopBtn = document.getElementById("stop-btn");
const devToggle = document.getElementById("dev-toggle");
const devPanel = document.getElementById("dev-panel");
const devBackdrop = document.getElementById("dev-backdrop");
const devDoneBtn = document.getElementById("dev-done-btn");
const devCurrentMode = document.getElementById("dev-current-mode");
const devExtra = document.getElementById("dev-extra");
const devSimulateBtn = document.getElementById("dev-simulate-btn");
const devDemoBtn = document.getElementById("dev-demo-btn");
const devSimCents = document.getElementById("dev-sim-cents");
const modeButtons = [...document.querySelectorAll(".dev-menu__item[data-mode]")];
const devSimCentsOut = document.getElementById("dev-sim-cents-out");
const devReadout = document.getElementById("dev-readout");
const noteDisplay = document.getElementById("seven-seg");
const centsLabel = document.getElementById("cents-label");
const statusLabel = document.getElementById("status-label");
const needleWrap = document.getElementById("needle-wrap");
const ticksGroup = document.getElementById("gauge-ticks");
const stringButtons = [...document.querySelectorAll(".tuner__string")];
const segElements = [...document.querySelectorAll(".seven-seg__seg")];

if (
  !(overlay instanceof HTMLElement) ||
  !(overlayBtn instanceof HTMLButtonElement) ||
  !(overlayHint instanceof HTMLElement) ||
  !(appMain instanceof HTMLElement) ||
  !(stopBtn instanceof HTMLButtonElement) ||
  !(devToggle instanceof HTMLButtonElement) ||
  !(devPanel instanceof HTMLElement) ||
  !(devBackdrop instanceof HTMLElement) ||
  !(devDoneBtn instanceof HTMLButtonElement) ||
  !(devCurrentMode instanceof HTMLElement) ||
  !(devExtra instanceof HTMLElement) ||
  !(devSimulateBtn instanceof HTMLButtonElement) ||
  !(devDemoBtn instanceof HTMLButtonElement) ||
  !(devSimCents instanceof HTMLInputElement) ||
  !modeButtons.every((b) => b instanceof HTMLButtonElement) ||
  !(devSimCentsOut instanceof HTMLOutputElement) ||
  !(devReadout instanceof HTMLElement) ||
  !(noteDisplay instanceof SVGSVGElement) ||
  !(centsLabel instanceof HTMLElement) ||
  !(statusLabel instanceof HTMLElement) ||
  !(needleWrap instanceof SVGGElement) ||
  !(ticksGroup instanceof SVGGElement) ||
  !stringButtons.every((b) => b instanceof HTMLButtonElement) ||
  !segElements.every((el) => el instanceof SVGRectElement)
) {
  throw new Error("Required DOM nodes missing");
}

new UIController({
  overlay,
  overlayBtn,
  overlayHint,
  appMain,
  stopBtn,
  devToggle,
  devPanel,
  devBackdrop,
  devDoneBtn,
  devCurrentMode,
  devExtra,
  devSimulateBtn,
  devDemoBtn,
  devSimCents,
  modeButtons,
  devSimCentsOut,
  devReadout,
  noteDisplay,
  segElements,
  centsLabel,
  statusLabel,
  needleWrap,
  ticksGroup,
  stringButtons,
});
