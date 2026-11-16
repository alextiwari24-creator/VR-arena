import * as THREE from 'three';

/**
 * Gimbal-lock-free 9-DoF / 6-DoF Adaptive Madgwick Quaternion Filter
 * paired with Velocity-Adaptive One-Euro Quaternion Smoother & Look-Ahead.
 *
 * Coordinate convention: Three.js right-handed Y-up world (+X right, +Y up, -Z forward).
 */
export class MadgwickAHRS {
  // Quaternion components (w, x, y, z)
  public q0 = 1;
  public q1 = 0;
  public q2 = 0;
  public q3 = 0;

  // Dynamic filter gain (automatically scales down when gyro is active & steady,
  // scales up on startup / after magnetic anomaly recovery)
  private baseBeta = 0.045;
  private activeBeta = 0.045;

  // One-Euro adaptive output smoother state
  private readonly filteredQuat = new THREE.Quaternion();
  private readonly prevRawQuat = new THREE.Quaternion();
  private readonly predictedQuat = new THREE.Quaternion();
  private readonly angVelAxis = new THREE.Vector3();
  private readonly deltaQuat = new THREE.Quaternion();
  private hasFilterSeed = false;

  public setBaseBeta(beta: number): void {
    this.baseBeta = THREE.MathUtils.clamp(beta, 0.01, 0.35);
  }

  public getActiveBeta(): number {
    return this.activeBeta;
  }

  public setFromQuaternion(q: THREE.Quaternion): void {
    this.q0 = q.w;
    this.q1 = q.x;
    this.q2 = q.y;
    this.q3 = q.z;
    this.normalize();
  }

  public toQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    return out.set(this.q1, this.q2, this.q3, this.q0).normalize();
  }

  /**
   * 6-DoF / 9-DoF quaternion integration & gradient-descent correction.
   * All inputs are in device/camera frame where:
   * - gx, gy, gz: rad/s (pitch X, yaw Y, roll Z)
   * - ax, ay, az: gravity/accelerometer vector (m/s^2)
   * - mx, my, mz: magnetometer vector (uT), optional when hasMag = false
   */
  public step(
    gx: number,
    gy: number,
    gz: number,
    ax: number,
    ay: number,
    az: number,
    hasAccel: boolean,
    mx: number,
    my: number,
    mz: number,
    hasMag: boolean,
    dt: number,
    motionTrust: number
  ): void {
    if (dt <= 0) return;

    let {q0, q1, q2, q3} = this;

    // 1. Quaternion rate of change from bias-corrected gyroscope
    let qDot1 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qDot2 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qDot3 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qDot4 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

    const rotSpeed = Math.hypot(gx, gy, gz);
    // Reduce corrective gain during fast turns to eliminate rubber-band lag,
    // boost slightly when stationary or near rest for horizon lock
    const speedFactor = 1 / (1 + rotSpeed * 0.45);
    this.activeBeta = this.baseBeta * (0.45 + 0.9 * motionTrust * speedFactor);

    if (hasAccel) {
      const aNorm = Math.hypot(ax, ay, az);
      if (aNorm > 0.25) {
        const invA = 1 / aNorm;
        const nax = ax * invA;
        const nay = ay * invA;
        const naz = az * invA;

        // Objective: align world +Y (0, 1, 0) rotated into sensor frame with normalized gravity
        // For Three.js Y-up: gravity up in sensor frame predicted from q is column 2 of R^T
        const fx = 2 * (q1 * q2 + q0 * q3) - nax;
        const fy = 1 - 2 * (q1 * q1 + q3 * q3) - nay;
        const fz = 2 * (q2 * q3 - q0 * q1) - naz;

        // Jacobian^T * f
        let s0 = 2 * q3 * fx - 2 * q1 * fz;
        let s1 = 2 * q2 * fx - 4 * q1 * fy - 2 * q0 * fz;
        let s2 = 2 * q1 * fx + 2 * q3 * fy * 0 + 2 * q3 * fz;
        let s3 = 2 * q0 * fx - 4 * q3 * fy + 2 * q2 * fz;

        // Incorporate 3D magnetometer heading gradient if available & stable
        if (hasMag) {
          const mNorm = Math.hypot(mx, my, mz);
          if (mNorm > 1) {
            const invM = 1 / mNorm;
            const nmx = mx * invM;
            const nmy = my * invM;
            const nmz = mz * invM;

            // Rotate magnetic vector into world frame to compute horizontal ref (bx, 0, bz)
            const q0q0 = q0 * q0;
            const q1q1 = q1 * q1;
            const q2q2 = q2 * q2;
            const q3q3 = q3 * q3;

            const hx =
              nmx * (q0q0 + q1q1 - q2q2 - q3q3) +
              nmy * 2 * (q1 * q2 - q0 * q3) +
              nmz * 2 * (q1 * q3 + q0 * q2);
            const hy =
              nmx * 2 * (q1 * q2 + q0 * q3) +
              nmy * (q0q0 - q1q1 + q2q2 - q3q3) +
              nmz * 2 * (q2 * q3 - q0 * q1);
            const hz =
              nmx * 2 * (q1 * q3 - q0 * q2) +
              nmy * 2 * (q2 * q3 + q0 * q1) +
              nmz * (q0q0 - q1q1 - q2q2 + q3q3);

            const bHoriz = Math.hypot(hx, hz);
            const bVert = hy;

            // Align horizontal reference along -Z north & vertical bVert along +Y
            const mfx = 2 * bVert * (q1 * q2 + q0 * q3) - 2 * bHoriz * (q1 * q3 - q0 * q2) - nmx;
            const mfy =
              bVert * (1 - 2 * (q1q1 + q3q3)) - 2 * bHoriz * (q2 * q3 + q0 * q1) - nmy;
            const mfz =
              2 * bVert * (q2 * q3 - q0 * q1) + bHoriz * (1 - 2 * (q1q1 + q2q2)) - nmz;

            const magWeight = 0.35;
            s0 +=
              magWeight *
              (mfx * (2 * bVert * q3 + 2 * bHoriz * q2) +
                mfy * (-2 * bHoriz * q1) +
                mfz * (-2 * bVert * q1));
            s1 +=
              magWeight *
              (mfx * (2 * bVert * q2 - 2 * bHoriz * q3) +
                mfy * (-4 * bVert * q1 - 2 * bHoriz * q0) +
                mfz * (-2 * bVert * q0 - 4 * bHoriz * q1));
            s2 +=
              magWeight *
              (mfx * (2 * bVert * q1 + 2 * bHoriz * q0) +
                mfy * (-2 * bHoriz * q3) +
                mfz * (2 * bVert * q3 - 4 * bHoriz * q2));
            s3 +=
              magWeight *
              (mfx * (2 * bVert * q0 - 2 * bHoriz * q1) +
                mfy * (-4 * bVert * q3 - 2 * bHoriz * q2) +
                mfz * (2 * bVert * q2));
          }
        }

        const sNorm = Math.hypot(s0, s1, s2, s3);
        if (sNorm > 1e-6) {
          const invS = 1 / sNorm;
          const gain = this.activeBeta * motionTrust;
          qDot1 -= gain * s0 * invS;
          qDot2 -= gain * s1 * invS;
          qDot3 -= gain * s2 * invS;
          qDot4 -= gain * s3 * invS;
        }
      }
    }

    q0 += qDot1 * dt;
    q1 += qDot2 * dt;
    q2 += qDot3 * dt;
    q3 += qDot4 * dt;

    this.q0 = q0;
    this.q1 = q1;
    this.q2 = q2;
    this.q3 = q3;
    this.normalize();
  }

  /**
   * Velocity-Adaptive One-Euro Quaternion SLERP + bounded angular look-ahead prediction.
   * Eliminates low-end sensor tremor while remaining ultra-responsive during head turns.
   */
  public filterOutput(
    rawTarget: THREE.Quaternion,
    dt: number,
    responsiveness: number,
    out: THREE.Quaternion
  ): THREE.Quaternion {
    if (!this.hasFilterSeed || dt <= 0) {
      this.filteredQuat.copy(rawTarget);
      this.prevRawQuat.copy(rawTarget);
      this.hasFilterSeed = true;
      return out.copy(rawTarget);
    }

    // Ensure shortest-path hemisphere
    if (this.prevRawQuat.dot(rawTarget) < 0) {
      rawTarget.set(-rawTarget.x, -rawTarget.y, -rawTarget.z, -rawTarget.w);
    }

    // Measure angular velocity between consecutive target poses
    const dotDelta = THREE.MathUtils.clamp(Math.abs(this.prevRawQuat.dot(rawTarget)), 0, 1);
    const stepAngle = 2 * Math.acos(dotDelta);
    const angSpeedRadSec = stepAngle / Math.max(dt, 0.002);

    // One-Euro adaptive cutoff: low cutoff during still gaze (< 0.12 rad/s),
    // high cutoff during deliberate head turns to prevent nauseating lag
    const minCutoffHz = 2.4 + responsiveness * 7.5;
    const speedSlope = 0.24 + responsiveness * 0.45;
    const cutoffHz = minCutoffHz + speedSlope * angSpeedRadSec;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = THREE.MathUtils.clamp(dt / (dt + rc), 0.12, 0.96);

    if (this.filteredQuat.dot(rawTarget) < 0) {
      this.filteredQuat.set(
        -this.filteredQuat.x,
        -this.filteredQuat.y,
        -this.filteredQuat.z,
        -this.filteredQuat.w
      );
    }
    this.filteredQuat.slerp(rawTarget, alpha);

    // Bounded predictive look-ahead (~10ms) to offset lower-end Android frame scanout latency
    if (stepAngle > 0.0008 && angSpeedRadSec > 0.08 && angSpeedRadSec < 9.0) {
      // Axis of rotation from prevRawQuat -> rawTarget
      this.deltaQuat.copy(this.prevRawQuat).invert().multiply(rawTarget).normalize();
      const sinHalf = Math.sqrt(Math.max(0, 1 - this.deltaQuat.w * this.deltaQuat.w));
      if (sinHalf > 1e-4) {
        this.angVelAxis.set(
          this.deltaQuat.x / sinHalf,
          this.deltaQuat.y / sinHalf,
          this.deltaQuat.z / sinHalf
        );
        const leadAngle = THREE.MathUtils.clamp((stepAngle / dt) * 0.01, -0.036, 0.036);
        this.deltaQuat.setFromAxisAngle(this.angVelAxis, leadAngle);
        this.predictedQuat.copy(this.filteredQuat).multiply(this.deltaQuat).normalize();
        out.copy(this.predictedQuat);
      } else {
        out.copy(this.filteredQuat);
      }
    } else {
      out.copy(this.filteredQuat);
    }

    this.prevRawQuat.copy(rawTarget);
    return out;
  }

  private normalize(): void {
    const inv = 1 / (Math.hypot(this.q0, this.q1, this.q2, this.q3) || 1);
    this.q0 *= inv;
    this.q1 *= inv;
    this.q2 *= inv;
    this.q3 *= inv;
  }
}
