/**
 * Small, frame-rate independent cloth response for a garment hanging from one point.
 * Driven only by how fast the turn playhead moves, it adds:
 *  - swing: the whole garment tilts around the hook as the turn speeds up and slows down;
 *  - lag:   the hem trails the turn and springs back past centre before settling;
 *  - ripple: a travelling wave down the fabric that fades out after the motion stops.
 * All outputs are small (a few pixels / about a degree) so the product stays readable.
 */
export const CLOTH = {
  swingStiffness: 46, swingDamping: 4.4, swingGain: .014, maxSwing: .03,
  lagStiffness: 70, lagDamping: 6.5, lagGain: 2.6, maxLag: 14,
  rippleGain: .9, rippleDecay: 2.4, rippleHz: 2.1, maxRipple: 1,
};

export function createCloth() {
  return {prev: null, speed: 0, swing: 0, swingV: 0, lag: 0, lagV: 0, ripple: 0, phase: 0};
}

/** Advance the cloth by dt milliseconds given the playhead `progress` (0 profile .. 1 front). Returns true while still moving. */
export function stepCloth(c, progress, dtMs, k = CLOTH) {
  if (!Number.isFinite(progress) || !Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Invalid cloth input');
  const dt = Math.min(dtMs, 50) / 1000;
  if (c.prev === null || dt === 0) { c.prev = progress; return isMoving(c); }
  const speed = (progress - c.prev) / dt; c.prev = progress;            // turns per second
  const accel = (speed - c.speed) / dt; c.speed += (speed - c.speed) * Math.min(1, dt * 18);
  // Pendulum swing around the hook, driven by angular acceleration of the turn.
  const sa = -k.swingStiffness * c.swing - k.swingDamping * c.swingV - k.swingGain * accel;
  c.swingV += sa * dt; c.swing = clamp(c.swing + c.swingV * dt, k.maxSwing);
  // Hem lag: springs toward a target that trails the turn speed, overshooting slightly on stop.
  const target = -k.lagGain * c.speed;
  const la = k.lagStiffness * (target - c.lag) - k.lagDamping * c.lagV;
  c.lagV += la * dt; c.lag = clamp(c.lag + c.lagV * dt, k.maxLag);
  // Ripple energy builds with speed and decays once the garment is still.
  c.ripple = Math.min(k.maxRipple, c.ripple * Math.exp(-k.rippleDecay * dt) + Math.abs(c.speed) * k.rippleGain * dt);
  c.phase = (c.phase + dt * k.rippleHz * Math.PI * 2) % (Math.PI * 2);
  return isMoving(c);
}

export function isMoving(c) {
  return Math.abs(c.swing) > 2e-4 || Math.abs(c.swingV) > 2e-3 || Math.abs(c.lag) > .06 || Math.abs(c.lagV) > .3 || c.ripple > .015 || Math.abs(c.speed) > .01;
}

/** Horizontal offset in pixels for a row at normalised depth `u` below the hook (0 = hook, 1 = hem). */
export function rowOffset(c, u, rippleAmplitude = 3.2) {
  if (u <= 0) return 0;
  const lag = c.lag * Math.pow(u, 1.7);
  const wave = c.ripple * rippleAmplitude * u * Math.sin(c.phase - u * 5.2);
  return lag + wave;
}

const clamp = (v, m) => Math.max(-m, Math.min(m, v));
