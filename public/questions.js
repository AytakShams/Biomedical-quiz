// Single source of truth for the quiz: the browser imports this as an ES module,
// and server.js imports the very same file to grade answers. Never duplicate the key.
//
// To add a question: append an object below. `id` must be a short, stable, unique
// slug -- it is written into the database, so NEVER rename or reuse an id, or old
// sessions' data stops lining up. Reordering questions is safe; renaming ids is not.

export const QUIZ = {
  id: "bioelectricity",
  title: "Spike or Subthreshold?",
  blurb: "12 questions on membrane and action potentials. Every right answer fires a spike on your trace; every miss dips below rest."
};

export const QUESTIONS = [
  {
    id: "charge-carrier",
    q: "What carries charge in biological systems, unlike man-made circuits?",
    correct: "Ions moving in an electrolyte across cell membranes",
    wrong: [
      "Electrons moving freely through a metallic conductor",
      "Protons moving through lipid insulation layers",
      "Photons crossing specialized protein channels"
    ],
    why: "Mobile ions (Na⁺, K⁺, Ca²⁺, Cl⁻) in aqueous electrolyte carry current through selective channels. Wires rely on free electrons."
  },
  {
    id: "resting-permeability",
    q: "At rest, how does K⁺ permeability compare with Na⁺ permeability?",
    correct: "PK is 50–100× larger than PNa",
    wrong: [
      "PK equals PNa",
      "PNa is 50–100× larger than PK",
      "The membrane is impermeable to both at rest"
    ],
    why: "Leak channels make the resting membrane far more permeable to K⁺, which pulls Vrest toward the K⁺ Nernst potential (about −90 mV)."
  },
  {
    id: "atp-pump",
    q: "Which mechanism uses ATP to maintain ionic gradients?",
    correct: "The Na⁺–K⁺ pump",
    wrong: [
      "Voltage-gated Na⁺ channels",
      "Passive K⁺ leak channels",
      "Bicarbonate diffusion exchangers"
    ],
    why: "The Na⁺–K⁺ ATPase is a primary active transporter that works against steep chemical gradients."
  },
  {
    id: "pump-ratio",
    q: "What is the Na⁺–K⁺ pump's transport ratio per cycle?",
    correct: "3 Na⁺ out, 2 K⁺ in",
    wrong: [
      "2 Na⁺ out, 3 K⁺ in",
      "3 Na⁺ in, 2 K⁺ out",
      "1 Na⁺ out, 1 K⁺ in"
    ],
    why: "Moving 3 positive charges out for 2 in makes the pump electrogenic, adding a little to internal negativity."
  },
  {
    id: "nernst-equilibrium",
    q: "When is a cell in Nernst equilibrium for an ion?",
    correct: "The electrical force balances the concentration-gradient force, so net flux is zero",
    wrong: [
      "All passive channels close permanently",
      "Inside and outside concentrations are equal",
      "Membrane capacitance drops to zero"
    ],
    why: "Equilibrium means the voltage across the membrane exactly opposes diffusion. Concentrations are not equal; the fluxes cancel."
  },
  {
    id: "depolarization-ion",
    q: "Which ion movement drives rapid depolarization?",
    correct: "Na⁺ influx",
    wrong: [
      "K⁺ efflux",
      "Ca²⁺ influx into the cytosol",
      "Cl⁻ efflux"
    ],
    why: "At threshold, voltage-gated Na⁺ channels open and Na⁺ rushes in down its electrochemical gradient."
  },
  {
    id: "myelination",
    q: "How does myelination change conduction?",
    correct: "It cuts leakage and speeds conduction about 20×",
    wrong: [
      "It slows conduction by raising capacitance",
      "It changes the peak amplitude of each spike",
      "It permanently prevents repolarization"
    ],
    why: "Myelin insulates the axon, lowering capacitance and leakage, so the impulse jumps between nodes of Ranvier (saltatory conduction)."
  },
  {
    id: "cardiac-vs-nerve",
    q: "How does a cardiac action potential compare with a nerve spike?",
    correct: "Cardiac has a 200–300 ms plateau; nerve spikes last about 2 ms",
    wrong: [
      "Cardiac potentials last only about 0.5 ms",
      "Both last about 2 ms",
      "Nerve potentials last 200–300 ms; cardiac cells fire instantly"
    ],
    why: "Sustained Ca²⁺ influx holds the cardiac plateau, giving time to contract and preventing tetanus."
  },
  {
    id: "depol-vs-hyperpol",
    q: "What separates depolarization from hyperpolarization?",
    correct: "Depolarization makes the inside less negative; hyperpolarization makes it more negative",
    wrong: [
      "Depolarization makes the inside more negative; hyperpolarization makes it positive",
      "Depolarization happens only at rest; hyperpolarization only at the peak",
      "Depolarization is K⁺ efflux; hyperpolarization is Na⁺ influx"
    ],
    why: "It is about direction relative to rest: toward zero or positive is depolarizing, further below rest is hyperpolarizing."
  },
  {
    id: "ap-phases",
    q: "What are the three sequential phases of an action potential?",
    correct: "Depolarization, repolarization, refractory period",
    wrong: [
      "Resting, activation, deactivation",
      "Influx, outflux, equilibrium",
      "Hyperpolarization, threshold peak, plateau"
    ],
    why: "Na⁺ influx depolarizes, K⁺ efflux repolarizes, then channels recover during the refractory period."
  },
  {
    id: "refractory-periods",
    q: "How do absolute and relative refractory periods differ?",
    correct: "Absolute: no stimulus can fire a spike. Relative: a stronger-than-normal stimulus can",
    wrong: [
      "Absolute = depolarized, relative = hyperpolarized",
      "Absolute applies only to skeletal muscle, relative only to smooth muscle",
      "In the relative period no spike can ever fire"
    ],
    why: "In the absolute period (1–3 ms) Na⁺ channels are inactivated. In the relative period they have recovered, but high K⁺ conductance and hyperpolarization demand a bigger stimulus."
  },
  {
    id: "all-or-none",
    q: "What does 'all-or-none' mean?",
    correct: "At or above threshold a full-size spike fires; below threshold, nothing",
    wrong: [
      "Amplitude scales with stimulus strength",
      "All ions cross at once or none do",
      "Spikes fire continuously at maximum frequency"
    ],
    why: "Once threshold is reached (about 15–20 mV above rest), the spike has a fixed, stereotyped amplitude. Sub-threshold stimuli produce no spike."
  }
];

// Map of id -> correct answer text. server.js grades against this; the browser uses it
// for instant feedback. Built once from QUESTIONS so the two can never drift apart.
export const ANSWER_KEY = new Map(QUESTIONS.map(q => [q.id, q.correct]));
