import * as xb from 'xrblocks';
import {VRStoreHubApp} from './VRStoreHubApp.ts';

document.addEventListener('DOMContentLoaded', () => {
  const options = new xb.Options();
  options.enableVR();
  options.enableReticles();
  options.enableHands();
  options.enableHandRays();
  options.enableGestures();
  options.enableHeadGestures();
  options.gestures.setGestureEnabled('pinch', true);
  options.gestures.setGestureEnabled('open-palm', true);
  options.gestures.setGestureEnabled('fist', true);
  options.gestures.setGestureEnabled('point', true);
  options.gestures.setGestureEnabled('spread', true);
  options.gestures.setGestureEnabled('thumbs-up', true);
  options.gestures.setGestureEnabled('thumbs-down', true);

  options.setAppTitle('PocketVR Play Hub');
  options.setAppDescription(
    'Install Android Play Store games & apps inside a virtual VR theater with all-hardware head tracking and hand gestures.'
  );

  xb.add(new VRStoreHubApp());
  void xb.init(options);
});
