import type { PitchNodePosition } from '../types/domain';

/**
 * Editable baseline catalog of tactical structures and parameters.
 * Users can customize, add, or remove items in Settings > FC26 Tactical Catalog
 * to match their exact EA SPORTS FC 26 title update and tactical options.
 */
export const DEFAULT_FORMATION_COORDINATES: Record<string, PitchNodePosition[]> = {
  '4-3-3 Holding': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Goalkeeper', defaultFocus: 'Defend' },
    { slotIndex: 1, slotId: 'LB', positionCode: 'LB', positionLabel: 'LB', x: 14, y: 74, defaultRole: 'Fullback', defaultFocus: 'Balanced' },
    { slotIndex: 2, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 37, y: 78, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 63, y: 78, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'RB', positionCode: 'RB', positionLabel: 'RB', x: 86, y: 74, defaultRole: 'Fullback', defaultFocus: 'Balanced' },
    { slotIndex: 5, slotId: 'CDM', positionCode: 'CDM', positionLabel: 'CDM', x: 50, y: 61, defaultRole: 'Holding', defaultFocus: 'Defend' },
    { slotIndex: 6, slotId: 'LCM', positionCode: 'CM', positionLabel: 'CM', x: 32, y: 48, defaultRole: 'Box-to-Box', defaultFocus: 'Balanced' },
    { slotIndex: 7, slotId: 'RCM', positionCode: 'CM', positionLabel: 'CM', x: 68, y: 48, defaultRole: 'Playmaker', defaultFocus: 'Attack' },
    { slotIndex: 8, slotId: 'LW', positionCode: 'LW', positionLabel: 'LW', x: 17, y: 27, defaultRole: 'Inside Forward', defaultFocus: 'Attack' },
    { slotIndex: 9, slotId: 'ST', positionCode: 'ST', positionLabel: 'ST', x: 50, y: 20, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
    { slotIndex: 10, slotId: 'RW', positionCode: 'RW', positionLabel: 'RW', x: 83, y: 27, defaultRole: 'Winger', defaultFocus: 'Balanced' },
  ],
  '4-2-3-1 Wide': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Goalkeeper', defaultFocus: 'Defend' },
    { slotIndex: 1, slotId: 'LB', positionCode: 'LB', positionLabel: 'LB', x: 14, y: 75, defaultRole: 'Fullback', defaultFocus: 'Defend' },
    { slotIndex: 2, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 37, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 63, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'RB', positionCode: 'RB', positionLabel: 'RB', x: 86, y: 75, defaultRole: 'Fullback', defaultFocus: 'Balanced' },
    { slotIndex: 5, slotId: 'LCDM', positionCode: 'CDM', positionLabel: 'CDM', x: 37, y: 60, defaultRole: 'Holding', defaultFocus: 'Defend' },
    { slotIndex: 6, slotId: 'RCDM', positionCode: 'CDM', positionLabel: 'CDM', x: 63, y: 60, defaultRole: 'Deep-Lying Playmaker', defaultFocus: 'Build-Up' },
    { slotIndex: 7, slotId: 'LM', positionCode: 'LM', positionLabel: 'LM', x: 16, y: 40, defaultRole: 'Inside Forward', defaultFocus: 'Balanced' },
    { slotIndex: 8, slotId: 'CAM', positionCode: 'CAM', positionLabel: 'CAM', x: 50, y: 38, defaultRole: 'Playmaker', defaultFocus: 'Roaming' },
    { slotIndex: 9, slotId: 'RM', positionCode: 'RM', positionLabel: 'RM', x: 84, y: 40, defaultRole: 'Winger', defaultFocus: 'Balanced' },
    { slotIndex: 10, slotId: 'ST', positionCode: 'ST', positionLabel: 'ST', x: 50, y: 19, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
  ],
  '4-4-2 Flat': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Goalkeeper', defaultFocus: 'Defend' },
    { slotIndex: 1, slotId: 'LB', positionCode: 'LB', positionLabel: 'LB', x: 14, y: 75, defaultRole: 'Fullback', defaultFocus: 'Defend' },
    { slotIndex: 2, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 37, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 63, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'RB', positionCode: 'RB', positionLabel: 'RB', x: 86, y: 75, defaultRole: 'Fullback', defaultFocus: 'Defend' },
    { slotIndex: 5, slotId: 'LM', positionCode: 'LM', positionLabel: 'LM', x: 15, y: 50, defaultRole: 'Wide Midfielder', defaultFocus: 'Balanced' },
    { slotIndex: 6, slotId: 'LCM', positionCode: 'CM', positionLabel: 'CM', x: 38, y: 53, defaultRole: 'Box-to-Box', defaultFocus: 'Balanced' },
    { slotIndex: 7, slotId: 'RCM', positionCode: 'CM', positionLabel: 'CM', x: 62, y: 53, defaultRole: 'Holding', defaultFocus: 'Defend' },
    { slotIndex: 8, slotId: 'RM', positionCode: 'RM', positionLabel: 'RM', x: 85, y: 50, defaultRole: 'Wide Midfielder', defaultFocus: 'Balanced' },
    { slotIndex: 9, slotId: 'LS', positionCode: 'ST', positionLabel: 'ST', x: 39, y: 22, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
    { slotIndex: 10, slotId: 'RS', positionCode: 'ST', positionLabel: 'ST', x: 61, y: 22, defaultRole: 'Poacher', defaultFocus: 'Attack' },
  ],
  '3-4-2-1': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Sweeper Keeper', defaultFocus: 'Balanced' },
    { slotIndex: 1, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 25, y: 77, defaultRole: 'Ball-Playing Defender', defaultFocus: 'Defend' },
    { slotIndex: 2, slotId: 'CB', positionCode: 'CB', positionLabel: 'CB', x: 50, y: 80, defaultRole: 'Stopper', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 75, y: 77, defaultRole: 'Ball-Playing Defender', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'LM', positionCode: 'LM', positionLabel: 'LM', x: 12, y: 53, defaultRole: 'Wide Midfielder', defaultFocus: 'Balanced' },
    { slotIndex: 5, slotId: 'LCM', positionCode: 'CM', positionLabel: 'CM', x: 38, y: 57, defaultRole: 'Holding', defaultFocus: 'Defend' },
    { slotIndex: 6, slotId: 'RCM', positionCode: 'CM', positionLabel: 'CM', x: 62, y: 57, defaultRole: 'Deep-Lying Playmaker', defaultFocus: 'Build-Up' },
    { slotIndex: 7, slotId: 'RM', positionCode: 'RM', positionLabel: 'RM', x: 88, y: 53, defaultRole: 'Wide Midfielder', defaultFocus: 'Balanced' },
    { slotIndex: 8, slotId: 'LCAM', positionCode: 'CAM', positionLabel: 'CAM', x: 33, y: 34, defaultRole: 'Shadow Striker', defaultFocus: 'Attack' },
    { slotIndex: 9, slotId: 'RCAM', positionCode: 'CAM', positionLabel: 'CAM', x: 67, y: 34, defaultRole: 'Half-Winger', defaultFocus: 'Balanced' },
    { slotIndex: 10, slotId: 'ST', positionCode: 'ST', positionLabel: 'ST', x: 50, y: 18, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
  ],
  '4-1-2-1-2 Narrow': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Goalkeeper', defaultFocus: 'Defend' },
    { slotIndex: 1, slotId: 'LB', positionCode: 'LB', positionLabel: 'LB', x: 14, y: 74, defaultRole: 'Attacking Wingback', defaultFocus: 'Balanced' },
    { slotIndex: 2, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 37, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 63, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'RB', positionCode: 'RB', positionLabel: 'RB', x: 86, y: 74, defaultRole: 'Attacking Wingback', defaultFocus: 'Balanced' },
    { slotIndex: 5, slotId: 'CDM', positionCode: 'CDM', positionLabel: 'CDM', x: 50, y: 63, defaultRole: 'Centre-Half', defaultFocus: 'Defend' },
    { slotIndex: 6, slotId: 'LCM', positionCode: 'CM', positionLabel: 'CM', x: 31, y: 49, defaultRole: 'Box-to-Box', defaultFocus: 'Balanced' },
    { slotIndex: 7, slotId: 'RCM', positionCode: 'CM', positionLabel: 'CM', x: 69, y: 49, defaultRole: 'Box-to-Box', defaultFocus: 'Balanced' },
    { slotIndex: 8, slotId: 'CAM', positionCode: 'CAM', positionLabel: 'CAM', x: 50, y: 36, defaultRole: 'Playmaker', defaultFocus: 'Balanced' },
    { slotIndex: 9, slotId: 'LS', positionCode: 'ST', positionLabel: 'ST', x: 38, y: 20, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
    { slotIndex: 10, slotId: 'RS', positionCode: 'ST', positionLabel: 'ST', x: 62, y: 20, defaultRole: 'False 9', defaultFocus: 'Build-Up' },
  ],
  '5-3-2': [
    { slotIndex: 0, slotId: 'GK', positionCode: 'GK', positionLabel: 'GK', x: 50, y: 92, defaultRole: 'Goalkeeper', defaultFocus: 'Defend' },
    { slotIndex: 1, slotId: 'LWB', positionCode: 'LWB', positionLabel: 'LWB', x: 12, y: 68, defaultRole: 'Wingback', defaultFocus: 'Balanced' },
    { slotIndex: 2, slotId: 'LCB', positionCode: 'CB', positionLabel: 'CB', x: 30, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 3, slotId: 'CB', positionCode: 'CB', positionLabel: 'CB', x: 50, y: 81, defaultRole: 'Stopper', defaultFocus: 'Defend' },
    { slotIndex: 4, slotId: 'RCB', positionCode: 'CB', positionLabel: 'CB', x: 70, y: 79, defaultRole: 'Defender', defaultFocus: 'Defend' },
    { slotIndex: 5, slotId: 'RWB', positionCode: 'RWB', positionLabel: 'RWB', x: 88, y: 68, defaultRole: 'Wingback', defaultFocus: 'Balanced' },
    { slotIndex: 6, slotId: 'LCM', positionCode: 'CM', positionLabel: 'CM', x: 32, y: 51, defaultRole: 'Box-to-Box', defaultFocus: 'Balanced' },
    { slotIndex: 7, slotId: 'CM', positionCode: 'CM', positionLabel: 'CM', x: 50, y: 55, defaultRole: 'Holding', defaultFocus: 'Defend' },
    { slotIndex: 8, slotId: 'RCM', positionCode: 'CM', positionLabel: 'CM', x: 68, y: 51, defaultRole: 'Playmaker', defaultFocus: 'Balanced' },
    { slotIndex: 9, slotId: 'LS', positionCode: 'ST', positionLabel: 'ST', x: 39, y: 22, defaultRole: 'Advanced Forward', defaultFocus: 'Attack' },
    { slotIndex: 10, slotId: 'RS', positionCode: 'ST', positionLabel: 'ST', x: 61, y: 22, defaultRole: 'Target Forward', defaultFocus: 'Balanced' },
  ],
};

export const DEFAULT_TACTICAL_CATALOG_SEED: Array<{
  category: 'formation' | 'build_up' | 'defensive_approach' | 'player_role' | 'player_focus';
  name: string;
  description: string;
}> = [
  // Formations
  { category: 'formation', name: '4-3-3 Holding', description: 'Single pivot midfield triangle with wide forwards.' },
  { category: 'formation', name: '4-2-3-1 Wide', description: 'Double pivot protection with central creator and wide support.' },
  { category: 'formation', name: '4-4-2 Flat', description: 'Two compact banks of four with dual striker partnership.' },
  { category: 'formation', name: '3-4-2-1', description: 'Back three rest defense with dual half-space creators.' },
  { category: 'formation', name: '4-1-2-1-2 Narrow', description: 'Central midfield diamond prioritizing vertical central overloads.' },
  { category: 'formation', name: '5-3-2', description: 'Low/mid-block five-back structure transitioning via wingbacks.' },

  // Build-Up Styles
  { category: 'build_up', name: 'Balanced', description: 'Adapts passing tempo and support runs to match situation.' },
  { category: 'build_up', name: 'Short Passing', description: 'Players come short for ball progression and positional play.' },
  { category: 'build_up', name: 'Counter', description: 'Rapid vertical runs into space immediately upon ball recovery.' },

  // Defensive Approaches
  { category: 'defensive_approach', name: 'Deep', description: 'Compact low defensive block protecting space behind the backline.' },
  { category: 'defensive_approach', name: 'Balanced', description: 'Standard mid-block defensive line with measured pressing triggers.' },
  { category: 'defensive_approach', name: 'High', description: 'Elevated defensive line compressing space in the opponent half.' },
  { category: 'defensive_approach', name: 'Aggressive', description: 'High-intensity front-foot pressing with offside trap risk.' },

  // Player Roles
  { category: 'player_role', name: 'Goalkeeper', description: 'Standard shot-stopping and box command.' },
  { category: 'player_role', name: 'Sweeper Keeper', description: 'Steps out aggressively to intercept through balls.' },
  { category: 'player_role', name: 'Defender', description: 'Maintains backline integrity and marks central zones.' },
  { category: 'player_role', name: 'Ball-Playing Defender', description: 'Steps into build-up to break first pressing line.' },
  { category: 'player_role', name: 'Fullback', description: 'Balanced defensive wide protection with selective overlaps.' },
  { category: 'player_role', name: 'Wingback', description: 'Provides primary attacking width along the touchline.' },
  { category: 'player_role', name: 'Falseback', description: 'Inverts into central midfield during possession phases.' },
  { category: 'player_role', name: 'Holding', description: 'Shields the back four and disrupts counterattacks.' },
  { category: 'player_role', name: 'Deep-Lying Playmaker', description: 'Dictates build-up tempo from deeper central zones.' },
  { category: 'player_role', name: 'Box-to-Box', description: 'Links defensive recovery with late runs into the penalty area.' },
  { category: 'player_role', name: 'Playmaker', description: 'Finds pockets between opponent lines to create final-third passes.' },
  { category: 'player_role', name: 'Half-Winger', description: 'Drifts into wide channels to overload opponent fullbacks.' },
  { category: 'player_role', name: 'Winger', description: 'Holds touchline width to stretch defensive compactness.' },
  { category: 'player_role', name: 'Inside Forward', description: 'Cuts inside onto stronger foot attacking the half-space.' },
  { category: 'player_role', name: 'Advanced Forward', description: 'Leads the line and attacks channels behind the backline.' },
  { category: 'player_role', name: 'False 9', description: 'Drops into midfield to pull centre-backs out of position.' },
  { category: 'player_role', name: 'Target Forward', description: 'Pins defenders and holds up vertical balls for runners.' },

  // Player Focuses
  { category: 'player_focus', name: 'Defend', description: 'Prioritizes defensive shape and transition protection.' },
  { category: 'player_focus', name: 'Balanced', description: 'Contributes evenly across attacking and defensive phases.' },
  { category: 'player_focus', name: 'Attack', description: 'Commits forward early into final-third zones.' },
  { category: 'player_focus', name: 'Build-Up', description: 'Offers safe passing angles during early progression.' },
  { category: 'player_focus', name: 'Roaming', description: 'Permitted to vacate zone to seek numerical superiority.' },
  { category: 'player_focus', name: 'Support', description: 'Stays close to ball carrier to maintain combination play.' },
];

export const ACTIVE_GEMINI_MODELS = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (Balanced Multimodal Default)',
    description: 'Fast multimodal video & tactical analysis with structured JSON output support.',
    tier: 'Standard',
  },
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (Quick / Low-Cost Video Triage)',
    description: 'Fast, low-cost multimodal model suitable for Quick mode and rapid triage.',
    tier: 'Budget',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (Low-Latency Multimodal)',
    description: 'Low-latency multimodal model for fast structured gameplay classification and analysis.',
    tier: 'Budget',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro (Deep Tactical Reasoning)',
    description: 'High-depth tactical synthesis for complex opposition breakdown and adjustments.',
    tier: 'Advanced',
  },
] as const;

export const PLAYER_POSITIONS = [
  'GK',
  'LB',
  'LWB',
  'CB',
  'RB',
  'RWB',
  'CDM',
  'CM',
  'CAM',
  'LM',
  'RM',
  'LW',
  'RW',
  'CF',
  'ST',
] as const;

export function getFormationPositions(formationName: string): PitchNodePosition[] {
  if (DEFAULT_FORMATION_COORDINATES[formationName]) {
    return DEFAULT_FORMATION_COORDINATES[formationName];
  }
  return DEFAULT_FORMATION_COORDINATES['4-3-3 Holding'];
}
