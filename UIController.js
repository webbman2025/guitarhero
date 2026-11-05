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

/** 7-segment patterns for open-string letters. */
const SEGMENT_LETTERS = {
  A: ["a", "b", "c", "e", "f", "g"],
  B: ["a", "b", "c", "d", "e", "f", "g"],
  D: ["b", "c", "d", "e", "g"],
  E: ["a", "d", "e", "f", "g"],
  G: ["a", "c", "d", "e", "f", "g"],
};

const CONFIDENCE_MIN = 0.9;
const IN_TUNE_CENTS = 3;
const NEEDLE_MIN = -45;
const NEEDLE_MAX = 45;
const CENTS_SPAN = 50;
const NEEDLE_PIVOT_X = 195;
const NEEDLE_PIVOT_Y = 168;
const GAUGE_RADIUS = 147;

export class UIController {
  /** @type {AudioEngine} */
  #engine = new AudioEngine();
  /** @type {number} */
  #rafId = 0;
  /** @type {number | null} */
  #needleTargetDeg = null;
  /** @type {number} */
  #needleDeg = 0;
  /** @type {string} */
  #selectedStringId = "G3";
  /** @type {boolean} */
  #manualString = false;

  /**
   * @param {{
   *   overlay: HTMLElement,
   *   overlayBtn: HTMLButtonElement,
   *   appMain: HTMLElement,
   *   stopBtn: HTMLButtonElement,
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
    this.#setSevenSegLetter("G", true);
    this.#bindEvents();
  }

  #bindEvents() {
    this.dom.overlayBtn.addEventListener("click", () => {
      void this.#onStartTap();
    });

    this.dom.stopBtn.addEventListener("click", () => {
      this.#shutdown();
    });

    for (const btn of this.dom.stringButtons) {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-string");
        if (!id) return;
        this.#selectedStringId = id;
        this.#manualString = true;
        this.#setActiveStringButton(id);
        const match = GUITAR_STRINGS.find((s) => s.id === id);
        if (match) {
          this.#setSevenSegLetter(match.letter, true);
        }
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.#engine.isRunning) {
        this.#shutdown();
      }
    });
  }

  async #onStartTap() {
    try {
      this.#manualString = false;
      await this.#engine.start();
      this.dom.overlay.classList.add("start-overlay--hidden");
      this.dom.appMain.setAttribute("aria-hidden", "false");
      this.dom.appMain.classList.add("tuner--live");
      this.dom.stopBtn.hidden = false;
      this.dom.statusLabel.textContent = "";
      if (!this.#rafId) {
        this.#rafId = requestAnimationFrame(() => this.#frame());
      }
    } catch (err) {
      console.error(err);
      this.dom.overlayBtn.textContent = "Microphone blocked — try again";
    }
  }

  #shutdown() {
    this.#engine.stop();
    cancelAnimationFrame(this.#rafId);
    this.#rafId = 0;
    this.#needleTargetDeg = null;
    this.#needleDeg = 0;
    this.dom.needleWrap.setAttribute(
      "transform",
      `rotate(0 ${NEEDLE_PIVOT_X} ${NEEDLE_PIVOT_Y})`,
    );
    this.dom.overlay.classList.remove("start-overlay--hidden");
    this.dom.appMain.setAttribute("aria-hidden", "true");
    this.dom.appMain.classList.remove("tuner--live");
    this.dom.stopBtn.hidden = true;
    this.dom.overlayBtn.textContent = "Tap to Start Tuner";
    this.dom.centsLabel.textContent = "";
    this.dom.centsLabel.classList.remove("tuner__cents--perfect");
    this.dom.statusLabel.textContent = "";
    this.#setSevenSegLetter("G", true);
  }

  #frame() {
    if (this.#engine.isRunning) {
      const buffer = this.#engine.readTimeDomainBuffer();
      if (buffer) {
        const result = this.#engine.detectPitch(buffer);
        if (result === false) {
          this.dom.statusLabel.textContent = "";
          this.dom.centsLabel.textContent = "";
          this.dom.centsLabel.classList.remove("tuner__cents--perfect");
        } else if (result.confidence < CONFIDENCE_MIN) {
          this.dom.statusLabel.textContent = "";
          this.dom.centsLabel.textContent = "";
          this.dom.centsLabel.classList.remove("tuner__cents--perfect");
        } else {
          this.#applyTuning(result.frequency);
        }
      }
    }

    this.#smoothNeedle();
    this.#rafId = requestAnimationFrame(() => this.#frame());
  }

  /** @param {number} frequency */
  #applyTuning(frequency) {
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
    this.#setSevenSegLetter(target.letter, true, inTune);

    if (inTune) {
      this.dom.statusLabel.textContent = "";
    } else {
      this.dom.statusLabel.textContent = cents > 0 ? "Sharp" : "Flat";
    }

    const rounded = Math.round(cents);
    const sign = rounded > 0 ? "+" : "";
    this.dom.centsLabel.classList.toggle("tuner__cents--perfect", inTune);
    this.dom.centsLabel.textContent = inTune ? "Perfect" : `${sign}${rounded}¢`;
  }

  /**
   * @param {string} letter
   * @param {boolean} active
   * @param {boolean} inTune
   */
  #setSevenSegLetter(letter, active, inTune = false) {
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
    if (this.#needleTargetDeg == null) {
      return;
    }
    this.#needleDeg += (this.#needleTargetDeg - this.#needleDeg) * 0.22;
    this.dom.needleWrap.setAttribute(
      "transform",
      `rotate(${this.#needleDeg.toFixed(2)} ${NEEDLE_PIVOT_X} ${NEEDLE_PIVOT_Y})`,
    );
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
const appMain = document.getElementById("app-main");
const stopBtn = document.getElementById("stop-btn");
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
  !(appMain instanceof HTMLElement) ||
  !(stopBtn instanceof HTMLButtonElement) ||
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
  appMain,
  stopBtn,
  noteDisplay,
  segElements,
  centsLabel,
  statusLabel,
  needleWrap,
  ticksGroup,
  stringButtons,
});
