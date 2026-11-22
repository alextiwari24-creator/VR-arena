export interface DeviceStatusSnapshot {
  deviceModel: string;
  platformLabel: string;
  batteryPct: number | null;
  batteryCharging: boolean;
  networkLabel: string;
  online: boolean;
  resolutionLabel: string;
  cpuCores: number;
  memoryGb: number | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsStatus: 'idle' | 'locating' | 'ready' | 'unavailable';
  screenMirrorActive: boolean;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

interface NetworkInfoLike extends EventTarget {
  effectiveType?: string;
  type?: string;
  downlink?: number;
}

class DeviceHomeServiceImpl {
  private batteryPct: number | null = null;
  private batteryCharging = false;
  private networkLabel = 'Online';
  private online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private gpsLat: number | null = null;
  private gpsLng: number | null = null;
  private gpsStatus: 'idle' | 'locating' | 'ready' | 'unavailable' = 'idle';

  private mirrorStream: MediaStream | null = null;
  private mirrorVideo: HTMLVideoElement | null = null;
  private initialized = false;

  init(): void {
    if (this.initialized || typeof navigator === 'undefined') return;
    this.initialized = true;

    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>;
      connection?: NetworkInfoLike;
    };

    if (typeof nav.getBattery === 'function') {
      void nav
        .getBattery()
        .then((bat) => {
          const updateBat = () => {
            this.batteryPct = Math.round(bat.level * 100);
            this.batteryCharging = Boolean(bat.charging);
          };
          updateBat();
          bat.addEventListener('levelchange', updateBat);
          bat.addEventListener('chargingchange', updateBat);
        })
        .catch(() => {});
    }

    const updateNet = () => {
      this.online = navigator.onLine;
      const conn = nav.connection;
      if (!navigator.onLine) {
        this.networkLabel = 'Offline';
      } else if (conn?.effectiveType) {
        const prefix = conn.type && conn.type !== 'unknown' ? conn.type.toUpperCase() : 'NET';
        this.networkLabel = `${prefix} ${conn.effectiveType.toUpperCase()}`;
      } else {
        this.networkLabel = 'Wi-Fi / Online';
      }
    };
    updateNet();
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);
    nav.connection?.addEventListener('change', updateNet);
  }

  requestGpsLocation(): Promise<{lat: number; lng: number} | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.gpsStatus = 'unavailable';
      return Promise.resolve(null);
    }
    if (this.gpsLat !== null && this.gpsLng !== null) {
      return Promise.resolve({lat: this.gpsLat, lng: this.gpsLng});
    }
    this.gpsStatus = 'locating';
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.gpsLat = pos.coords.latitude;
          this.gpsLng = pos.coords.longitude;
          this.gpsStatus = 'ready';
          resolve({lat: this.gpsLat, lng: this.gpsLng});
        },
        () => {
          this.gpsStatus = 'unavailable';
          resolve(null);
        },
        {enableHighAccuracy: false, timeout: 6000, maximumAge: 120000}
      );
    });
  }

  async toggleDeviceScreenMirror(): Promise<boolean> {
    if (this.mirrorStream) {
      this.stopDeviceScreenMirror();
      return false;
    }
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
    ) {
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {frameRate: {ideal: 30, max: 60}},
        audio: false,
      });
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        this.stopDeviceScreenMirror();
      });
      this.mirrorStream = stream;
      this.mirrorVideo = video;
      return true;
    } catch {
      this.stopDeviceScreenMirror();
      return false;
    }
  }

  stopDeviceScreenMirror(): void {
    if (this.mirrorStream) {
      for (const track of this.mirrorStream.getTracks()) {
        track.stop();
      }
      this.mirrorStream = null;
    }
    if (this.mirrorVideo) {
      this.mirrorVideo.srcObject = null;
      this.mirrorVideo = null;
    }
  }

  getMirrorVideo(): HTMLVideoElement | null {
    return this.mirrorVideo;
  }

  isScreenMirrorActive(): boolean {
    return Boolean(this.mirrorStream && this.mirrorVideo);
  }

  getSnapshot(): DeviceStatusSnapshot {
    this.init();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isAndroid = /Android/i.test(ua);
    const androidMatch = ua.match(/Android\s+([0-9.]+);\s*([^;)]+)/i);
    const deviceModel = androidMatch
      ? androidMatch[2].trim()
      : isAndroid
        ? 'Android Device'
        : /Mac/i.test(ua)
          ? 'Mac Desktop'
          : /Windows/i.test(ua)
            ? 'Windows PC'
            : /Linux/i.test(ua)
              ? 'Linux Device'
              : 'User Device';

    const platformLabel = androidMatch
      ? `Android ${androidMatch[1]}`
      : isAndroid
        ? 'Android OS'
        : 'WebXR Device';

    const nav = typeof navigator !== 'undefined'
      ? (navigator as Navigator & {deviceMemory?: number})
      : null;

    const w = typeof window !== 'undefined' ? window.screen?.width ?? window.innerWidth : 1920;
    const h = typeof window !== 'undefined' ? window.screen?.height ?? window.innerHeight : 1080;

    return {
      deviceModel,
      platformLabel,
      batteryPct: this.batteryPct,
      batteryCharging: this.batteryCharging,
      networkLabel: this.networkLabel,
      online: this.online,
      resolutionLabel: `${w}×${h}`,
      cpuCores: nav?.hardwareConcurrency ?? 4,
      memoryGb: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
      gpsLat: this.gpsLat,
      gpsLng: this.gpsLng,
      gpsStatus: this.gpsStatus,
      screenMirrorActive: this.isScreenMirrorActive(),
    };
  }
}

export const deviceHomeService = new DeviceHomeServiceImpl();
