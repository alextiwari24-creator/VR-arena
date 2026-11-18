import * as THREE from 'three';
import * as xb from 'xrblocks';
import {SoundEngine} from '../audio/SoundEngine.ts';

export type SpatialWorkspaceTab = 'all' | 'launcher' | 'store' | 'browser' | 'sensors';

export interface SpatialDockCallbacks {
  onSelectWorkspace: (tab: SpatialWorkspaceTab) => void;
  onToggleStereo: () => void;
  onRecenter: () => void;
  onExitApp: () => void;
  onTriggerGazeSelect: () => void;
}

/**
 * World-space horizon-stabilized Spatial Command Dock.
 * Renders cleanly in both eyes in Cardboard SBS Stereo & WebXR so users can
 * navigate menus, switch workspaces, recenter, and exit apps using only
 * head movements + simple button presses.
 */
export class SpatialCommandDock extends xb.UICard {
  private readonly sound: SoundEngine;
  private readonly callbacks: SpatialDockCallbacks;

  private activeTab: SpatialWorkspaceTab = 'all';
  private followYaw = true;
  private currentYaw = 0;
  private initializedPose = false;

  private gazePromptText: xb.UIText;
  private activeAppBadge: xb.UIText;
  private tabButtons = new Map<SpatialWorkspaceTab, xb.UIButton>();
  private stereoBtn: xb.UIButton;
  private recenterBtn: xb.UIButton;
  private followBtn: xb.UIButton;
  private selectBtn: xb.UIButton;
  private exitAppBtn: xb.UIButton;

  private readonly _camPos = new THREE.Vector3();
  private readonly _camDir = new THREE.Vector3();
  private readonly _targetPos = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();

  constructor(sound: SoundEngine, callbacks: SpatialDockCallbacks) {
    const gazePromptText = new xb.UIText({
      text: 'Gaze 1s / Space / Tap = Select • Esc / Shake = Back',
      pointerEvents: 'none',
      style: {fontSize: 12.5, color: '#38bdf8', fontWeight: 'bold', flexGrow: 1},
    });
    const activeAppBadge = new xb.UIText({
      text: 'Mode: Spatial Hub',
      pointerEvents: 'none',
      style: {fontSize: 11.5, color: '#94a3b8', textAlign: 'right'},
    });

    const tabs: Array<{id: SpatialWorkspaceTab; label: string; icon: string}> = [
      {id: 'all', label: 'All Cockpit', icon: 'dashboard'},
      {id: 'launcher', label: 'Installed', icon: 'apps'},
      {id: 'store', label: 'Play Store', icon: 'shop'},
      {id: 'browser', label: 'Web Browser', icon: 'public'},
      {id: 'sensors', label: 'Sensors', icon: 'sensors'},
    ];
    const tabButtons = new Map<SpatialWorkspaceTab, xb.UIButton>();
    const tabChildren: xb.UIButton[] = [];
    for (const t of tabs) {
      const btn = new xb.UIButton({
        label: t.label,
        icon: t.icon,
        style: {
          flexGrow: 1,
          height: 36,
          fontSize: 12,
          ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.28)'},
        },
      });
      tabButtons.set(t.id, btn);
      tabChildren.push(btn);
    }

    const selectBtn = new xb.UIButton({
      label: 'Select (Space)',
      icon: 'touch_app',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        backgroundColor: 'rgba(52, 211, 153, 0.22)',
        ':hover': {backgroundColor: 'rgba(52, 211, 153, 0.38)'},
      },
    });
    const stereoBtn = new xb.UIButton({
      label: 'VR SBS: OFF',
      icon: 'vrpano',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.28)'},
      },
    });
    const recenterBtn = new xb.UIButton({
      label: 'Recenter',
      icon: 'center_focus_strong',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.28)'},
      },
    });
    const followBtn = new xb.UIButton({
      label: 'Dock: Follow',
      icon: 'explore',
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        ':hover': {backgroundColor: 'rgba(56, 189, 248, 0.28)'},
      },
    });
    const exitAppBtn = new xb.UIButton({
      label: 'Exit App',
      icon: 'stop_circle',
      visible: false,
      style: {
        flexGrow: 1,
        height: 36,
        fontSize: 12,
        backgroundColor: 'rgba(244, 63, 94, 0.32)',
        ':hover': {backgroundColor: 'rgba(244, 63, 94, 0.5)'},
      },
    });

    super({
      size: {width: 1.04, height: 'auto'},
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 7,
        padding: 12,
        borderRadius: 20,
      },
      children: [
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            paddingLeft: 6,
            paddingRight: 6,
          },
          children: [gazePromptText, activeAppBadge],
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 6},
          children: tabChildren,
        }),
        new xb.UIPanel({
          style: {width: '100%', flexDirection: 'row', gap: 6},
          children: [selectBtn, stereoBtn, recenterBtn, followBtn, exitAppBtn],
        }),
      ],
    });

    this.name = 'Spatial Command Dock';
    this.sound = sound;
    this.callbacks = callbacks;
    this.gazePromptText = gazePromptText;
    this.activeAppBadge = activeAppBadge;
    this.tabButtons = tabButtons;
    this.selectBtn = selectBtn;
    this.stereoBtn = stereoBtn;
    this.recenterBtn = recenterBtn;
    this.followBtn = followBtn;
    this.exitAppBtn = exitAppBtn;

    this.position.set(0, 0.82, -1.04);
    this.rotation.x = -0.34;

    this.wireActions();
    this.refreshTabStyles();
  }

  private wireActions(): void {
    for (const [id, btn] of this.tabButtons.entries()) {
      btn.onClick = () => {
        this.sound.playClick();
        this.setActiveTab(id);
        this.callbacks.onSelectWorkspace(id);
      };
    }

    this.selectBtn.onClick = () => {
      this.sound.playClick();
      this.callbacks.onTriggerGazeSelect();
    };

    this.stereoBtn.onClick = () => {
      this.sound.playClick();
      this.callbacks.onToggleStereo();
    };

    this.recenterBtn.onClick = () => {
      this.sound.playClick();
      this.callbacks.onRecenter();
      this.snapToCurrentHeading();
    };

    this.followBtn.onClick = () => {
      this.sound.playClick();
      this.followYaw = !this.followYaw;
      this.followBtn.label = this.followYaw ? 'Dock: Follow' : 'Dock: Pinned';
      this.followBtn.icon = this.followYaw ? 'explore' : 'push_pin';
    };

    this.exitAppBtn.onClick = () => {
      this.sound.playClick();
      this.callbacks.onExitApp();
    };
  }

  public setActiveTab(tab: SpatialWorkspaceTab): void {
    this.activeTab = tab;
    this.refreshTabStyles();
  }

  private refreshTabStyles(): void {
    for (const [id, btn] of this.tabButtons.entries()) {
      btn.style.backgroundColor =
        id === this.activeTab ? 'rgba(56, 189, 248, 0.42)' : 'rgba(255, 255, 255, 0.08)';
    }
  }

  public setStatusInfo(gazeLabel: string, dwellPct: number, activeAppName: string | null): void {
    if (gazeLabel) {
      this.gazePromptText.text =
        dwellPct > 5 ? `Selecting ${dwellPct}%: ${gazeLabel}` : `Target: ${gazeLabel}`;
      this.gazePromptText.style.color = dwellPct > 5 ? '#34d399' : '#38bdf8';
    } else {
      this.gazePromptText.text = 'Look at any menu item • Dwell 1s / Space / Tap to Select';
      this.gazePromptText.style.color = '#93c5fd';
    }

    if (activeAppName) {
      this.activeAppBadge.text = `Active VR: ${activeAppName}`;
      this.activeAppBadge.style.color = '#34d399';
      this.exitAppBtn.visible = true;
    } else {
      this.activeAppBadge.text = 'Spatial VR Hub';
      this.activeAppBadge.style.color = '#94a3b8';
      this.exitAppBtn.visible = false;
    }
  }

  public setStereoState(enabled: boolean): void {
    const label = enabled ? 'VR SBS: ON' : 'VR SBS: OFF';
    if (this.stereoBtn.label !== label) {
      this.stereoBtn.label = label;
      this.stereoBtn.style.backgroundColor = enabled
        ? 'rgba(56, 189, 248, 0.36)'
        : 'rgba(255, 255, 255, 0.08)';
    }
  }

  public snapToCurrentHeading(): void {
    const cam = xb.core.camera;
    if (!cam) return;
    cam.getWorldPosition(this._camPos);
    cam.getWorldDirection(this._camDir);
    const yaw = Math.atan2(-this._camDir.x, -this._camDir.z);
    this.currentYaw = yaw;
    this.initializedPose = true;
    this.position.set(
      this._camPos.x - Math.sin(yaw) * 1.04,
      this._camPos.y - 0.46,
      this._camPos.z - Math.cos(yaw) * 1.04
    );
    this._lookTarget.set(this._camPos.x, this._camPos.y - 0.14, this._camPos.z);
    this.lookAt(this._lookTarget);
  }

  update(): void {
    super.update();
    if (!this.visible || !this.followYaw) return;
    if (xb.user?.isManipulating?.(this)) return;

    const cam = xb.core.camera;
    if (!cam) return;

    cam.getWorldPosition(this._camPos);
    cam.getWorldDirection(this._camDir);
    const horizLen = Math.hypot(this._camDir.x, this._camDir.z);
    if (horizLen < 0.15) return; // Ignore steep straight-up/down pitch angles

    const camYaw = Math.atan2(-this._camDir.x, -this._camDir.z);
    if (!this.initializedPose) {
      this.currentYaw = camYaw;
      this.initializedPose = true;
    }

    // Wrap angle delta into [-PI, PI] and maintain a 20-deg deadzone so looking at dock edges stays stable
    let diff = camYaw - this.currentYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const deadzoneRad = 0.35;
    if (Math.abs(diff) > deadzoneRad) {
      const targetYaw = camYaw - Math.sign(diff) * deadzoneRad;
      let step = targetYaw - this.currentYaw;
      while (step > Math.PI) step -= Math.PI * 2;
      while (step < -Math.PI) step += Math.PI * 2;
      const dt = Math.min(xb.getDeltaTime(), 0.05);
      this.currentYaw += step * Math.min(1, dt * 4.5);
    }

    this._targetPos.set(
      this._camPos.x - Math.sin(this.currentYaw) * 1.04,
      this._camPos.y - 0.46,
      this._camPos.z - Math.cos(this.currentYaw) * 1.04
    );
    const dt = Math.min(xb.getDeltaTime(), 0.05);
    this.position.lerp(this._targetPos, Math.min(1, dt * 6));
    this._lookTarget.set(this._camPos.x, this._camPos.y - 0.14, this._camPos.z);
    this.lookAt(this._lookTarget);
  }
}
