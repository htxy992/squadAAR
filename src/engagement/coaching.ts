import type { EngagementReport, CoachingFlag } from './types.js';

const LONG_TTK_MS = 800;
/** Burst spread above this triggers spray_control_poor (degrees RMS). */
const POOR_SPRAY_SPREAD_DEG = 3;
/** Fraction of burst first-shots that miss to trigger first_shot_missed. */
const FIRST_SHOT_MISS_RATE = 0.5;
/** Two deaths within this angular sector (degrees) = repeated_same_angle. */
const ANGLE_SECTOR_DEG = 30;

/**
 * Apply coaching flags to a list of engagements in-place.
 * Call this after buildEngagements() and detectBursts().
 * Engagements must be ordered by tMs (earliest first) so repeated-angle
 * detection can accumulate deaths across the session correctly.
 */
export function applyCoachingFlags(engagements: EngagementReport[]): void {
  // Track the horizontal angles from which each player was killed this round
  const deathAngles = new Map<string, number[]>();

  for (const eng of engagements) {
    const flags: CoachingFlag[] = [];
    const details: EngagementReport['flagDetails'] = {};

    const hasKill = eng.outcome !== 'no_kill';
    const loserEOS =
      eng.outcome === 'attacker_won'
        ? eng.defenderEOSID
        : eng.outcome === 'defender_won'
          ? eng.attackerEOSID
          : null;

    // ── first_blood_lost ──────────────────────────────────────────────────
    if (hasKill && loserEOS && eng.firstShooterEOSID === loserEOS) {
      flags.push('first_blood_lost');
      details.first_blood_lost =
        `Erster Schuss von dir, trotzdem verloren — ` +
        (eng.ttkMs != null ? `TTK ${eng.ttkMs} ms` : `TTK unbekannt`) +
        `. Trefferbild oder Burst-Disziplin verbessern.`;
    }

    // ── peek_killed ───────────────────────────────────────────────────────
    const loserWasMoving =
      loserEOS === eng.attackerEOSID ? eng.attackerWasMoving : eng.defenderWasMoving;
    if (hasKill && loserEOS && loserWasMoving) {
      flags.push('peek_killed');
      details.peek_killed =
        `Du warst in Bewegung als der tödliche Schuss fiel — der Gegner hatte den Winkel pre-aimed.`;
    }

    // ── pre_aim_advantage (positive signal, tagged on the engagement) ─────
    const winnerEOS =
      eng.outcome === 'attacker_won'
        ? eng.attackerEOSID
        : eng.outcome === 'defender_won'
          ? eng.defenderEOSID
          : null;
    const winnerWasMoving =
      winnerEOS === eng.attackerEOSID ? eng.attackerWasMoving : eng.defenderWasMoving;
    if (hasKill && winnerEOS && !winnerWasMoving && loserWasMoving) {
      flags.push('pre_aim_advantage');
      details.pre_aim_advantage =
        `Sieger stand still (pre-aimed), Verlierer war in Bewegung — klassisches Peek-getötet.`;
    }

    // ── outnumbered_entry ─────────────────────────────────────────────────
    if (eng.nearbyTeammatesDefender.length >= 2) {
      flags.push('outnumbered_entry');
      details.outnumbered_entry =
        `Attacker hat in ${eng.nearbyTeammatesDefender.length + 1}v1 gepusht — Information fehlt oder Kommunikation.`;
    }

    // ── trade_missed ──────────────────────────────────────────────────────
    if (hasKill && loserEOS && eng.tradeOpportunity && eng.outcome !== 'traded') {
      flags.push('trade_missed');
      const allies = loserEOS === eng.attackerEOSID
        ? eng.nearbyTeammatesAttacker
        : eng.nearbyTeammatesDefender;
      details.trade_missed =
        `${allies.length} Teamkamerad(en) ≤ 30 m — kein Trade. Kommunikation nach Tod verbessern.`;
    }

    // ── long_ttk ──────────────────────────────────────────────────────────
    if (hasKill && winnerEOS && eng.ttkMs != null && eng.ttkMs > LONG_TTK_MS) {
      flags.push('long_ttk');
      details.long_ttk =
        `TTK ${eng.ttkMs} ms (Schwelle ${LONG_TTK_MS} ms) — mehr Treffer auf Torso/Kopf, kürzere Bursts.`;
    }

    // ── spray_control_poor ────────────────────────────────────────────────
    if (loserEOS) {
      const loserShots =
        loserEOS === eng.attackerEOSID ? eng.attackerShots : eng.defenderShots;
      // RMS spread of all recoilH/V after bullet 1 in each burst
      const deviations = loserShots
        .filter(b => (b.burstIndex ?? 1) > 1)
        .flatMap(b => [b.recoilH ?? 0, b.recoilV ?? 0]);
      if (deviations.length >= 4) {
        const spread = Math.sqrt(deviations.reduce((s, v) => s + v * v, 0) / deviations.length);
        if (spread > POOR_SPRAY_SPREAD_DEG) {
          flags.push('spray_control_poor');
          details.spray_control_poor =
            `${spread.toFixed(1)}° RMS Streuung (Schwelle ${POOR_SPRAY_SPREAD_DEG}°) — Rückstoß nach oben korrigieren.`;
        }
      }
    }

    // ── first_shot_missed ─────────────────────────────────────────────────
    if (loserEOS) {
      const loserShots =
        loserEOS === eng.attackerEOSID ? eng.attackerShots : eng.defenderShots;
      const firstShots = loserShots.filter(b => b.burstIndex === 1);
      if (firstShots.length >= 2) {
        const missRate = firstShots.filter(b => !b.hit).length / firstShots.length;
        if (missRate > FIRST_SHOT_MISS_RATE) {
          flags.push('first_shot_missed');
          details.first_shot_missed =
            `${Math.round(missRate * 100)} % der ersten Schüsse verfehlt — Aim-Placement vor dem Peek verbessern.`;
        }
      }
    }

    // ── repeated_same_angle ───────────────────────────────────────────────
    if (hasKill && loserEOS && eng.killerEOSID) {
      // Approximate death angle: direction from killer to victim at engagement start
      const defSampleAtStart = loserEOS === eng.defenderEOSID ? eng.engagementPos : null;
      const atkPos = eng.engagementPos;
      // We compute the angle of the approach vector (attacker → defender)
      const dx = (loserEOS === eng.defenderEOSID ? 0 : -(eng.approachDeltaCm ?? 0));
      const deathYaw = Math.atan2(
        eng.engagementPos.y - atkPos.y + dx,
        eng.engagementPos.x - atkPos.x
      ) * (180 / Math.PI);

      const past = deathAngles.get(loserEOS) ?? [];
      const repeated = past.some(a => Math.abs(normAngle(a - deathYaw)) < ANGLE_SECTOR_DEG);
      if (repeated) {
        flags.push('repeated_same_angle');
        details.repeated_same_angle =
          `Gleicher Todeswinkel (±${ANGLE_SECTOR_DEG}°) wie in vorherigem Engagement — anderen Eingang oder Timing.`;
      }
      past.push(deathYaw);
      deathAngles.set(loserEOS, past);
    }

    eng.flags = flags;
    eng.flagDetails = details;
  }
}

function normAngle(deg: number): number {
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return deg;
}
