/**
 * Static catalogues shared by server and client code.
 *
 * Kept free of any server-only import so client components can render the
 * pickers without dragging the persistence layer into the browser bundle.
 */

export const INDUSTRIES = [
  { value: 'clinic', label: 'Clinic / medical centre' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'retail', label: 'Retail / e-commerce' },
  { value: 'logistics', label: 'Logistics & delivery' },
  { value: 'education', label: 'Education' },
  { value: 'hospitality', label: 'Hotel / restaurant' },
  { value: 'beauty', label: 'Beauty & wellness' },
  { value: 'automotive', label: 'Automotive' },
  { value: 'telecom', label: 'Telecom / utilities' },
  { value: 'finance', label: 'Bank / fintech' },
  { value: 'other', label: 'Something else' },
] as const;

export const VOICES = [
  { id: 'nilufar', name: 'Nilufar', gender: 'female', langs: ['uz', 'ru'], note: 'Warm, unhurried — the default for clinics' },
  { id: 'aziz', name: 'Aziz', gender: 'male', langs: ['uz', 'ru'], note: 'Steady and clear' },
  { id: 'kamila', name: 'Kamila', gender: 'female', langs: ['ru', 'en'], note: 'Bright, quick-paced' },
  { id: 'timur', name: 'Timur', gender: 'male', langs: ['uz', 'en'], note: 'Low register, formal' },
  { id: 'sevara', name: 'Sevara', gender: 'female', langs: ['uz', 'ru', 'en'], note: 'Trilingual, neutral accent' },
] as const;

export const PERSONAS = [
  { value: 'professional', label: 'Professional', hint: 'Composed and efficient' },
  { value: 'friendly', label: 'Friendly', hint: 'Warm, a little conversational' },
  { value: 'concise', label: 'Concise', hint: 'Answers and stops' },
  { value: 'empathetic', label: 'Empathetic', hint: 'Acknowledges the caller first' },
] as const;

export const PLANS = [
  {
    id: 'trial',
    name: 'Trial',
    priceUsd: 0,
    callsIncluded: 250,
    numbers: 1,
    seats: 3,
    storageMb: 100,
    blurb: '14 days to decide.',
  },
  {
    id: 'start',
    name: 'Start',
    priceUsd: 490,
    callsIncluded: 1000,
    numbers: 1,
    seats: 3,
    storageMb: 500,
    blurb: 'One number, one agent.',
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsd: 1890,
    callsIncluded: 10000,
    numbers: 5,
    seats: 999,
    storageMb: 5000,
    blurb: 'Multi-branch with an operator team.',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: 4490,
    callsIncluded: 100000,
    numbers: 50,
    seats: 999,
    storageMb: 50000,
    blurb: 'Residency, SSO and an SLA.',
  },
] as const;

export const OVERAGE_PER_MINUTE = 0.065;

export const ESCALATION_REASON_LABEL: Record<string, string> = {
  low_confidence: 'Not confident enough',
  explicit_request: 'Caller asked for a human',
  negative_sentiment: 'Caller was unhappy',
  repeated_failure: 'Several unanswered questions',
  after_hours: 'Outside business hours',
  max_turns: 'Conversation ran long',
};

export const CALL_STATUS_LABEL: Record<string, string> = {
  ringing: 'Ringing',
  active: 'In progress',
  escalating: 'Handing over',
  with_operator: 'With operator',
  completed: 'Completed',
  abandoned: 'Abandoned',
  failed: 'Failed',
};

export const OUTCOME_LABEL: Record<string, string> = {
  resolved_by_ai: 'Resolved by AI',
  resolved_by_operator: 'Resolved by operator',
  abandoned: 'Abandoned',
  voicemail: 'Voicemail',
};

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  analyst: 'Analyst',
};

export const WEEKDAYS = [
  { key: '1', label: 'Monday', short: 'Mon' },
  { key: '2', label: 'Tuesday', short: 'Tue' },
  { key: '3', label: 'Wednesday', short: 'Wed' },
  { key: '4', label: 'Thursday', short: 'Thu' },
  { key: '5', label: 'Friday', short: 'Fri' },
  { key: '6', label: 'Saturday', short: 'Sat' },
  { key: '0', label: 'Sunday', short: 'Sun' },
] as const;
