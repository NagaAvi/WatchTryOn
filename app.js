import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const CAMERA_FOV = 35;
const CAMERA_Z = 2.6;
const POSITION_SMOOTHING = 0.16;
const ROTATION_SMOOTHING = 0.12;
const SCALE_SMOOTHING = 0.16;
const BASIS_VECTOR_SMOOTHING = 0.2;
const HAND_LOSS_FRAMES = 8;
const WRIST_BACK_OFFSET = 0.24;
const WRIST_SURFACE_OFFSET = 0.03;
const IMPORTED_MODEL_ROLL_OFFSET = Math.PI / 2;
const IMPORTED_MODEL_LENGTH_WEIGHT = 0.72;
const IMPORTED_MODEL_TARGET_SPAN = 1.08;
const WATCH_SCALE_MULTIPLIER = 1.75;
const WATCH_SCALE_MIN = 0.22;
const WATCH_SCALE_MAX = 0.52;

const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

const elements = {
  stage: document.querySelector("#stage"),
  video: document.querySelector("#camera"),
  debugCanvas: document.querySelector("#debugCanvas"),
  startButton: document.querySelector("#startButton"),
  debugButton: document.querySelector("#debugButton"),
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
};

const debugContext = elements.debugCanvas.getContext("2d");
const rayPoint = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const worldAnchor = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const targetScale = new THREE.Vector3(1, 1, 1);
const projectedWidth = new THREE.Vector3();
const projectedForward = new THREE.Vector3();
const projectedNormal = new THREE.Vector3();
const projectedIndexBaseWorld = new THREE.Vector3();
const projectedPinkyBaseWorld = new THREE.Vector3();
const forward = new THREE.Vector3();
const width = new THREE.Vector3();
const normal = new THREE.Vector3();
const orthogonalWidth = new THREE.Vector3();
const tempVector = new THREE.Vector3();
const tempVectorB = new THREE.Vector3();
const targetQuaternion = new THREE.Quaternion();
const basisMatrix = new THREE.Matrix4();
const boundingBox = new THREE.Box3();
const boxSize = new THREE.Vector3();
const boxCenter = new THREE.Vector3();
const previousForward = new THREE.Vector3();
const previousNormal = new THREE.Vector3();

const state = {
  handLandmarker: null,
  stream: null,
  running: false,
  debugVisible: true,
  lastVideoTime: -1,
  framesWithoutHand: 0,
  renderer: null,
  scene: null,
  camera: null,
  watchRig: null,
  watchVisual: null,
  watchHeadAnchor: null,
  watchOccluder: null,
  proceduralHead: null,
  smoothedPoseInitialized: false,
  palmMix: 0,
  sideMix: 0,
  watchHeadMaterials: [],
  strapMaterials: [],
  strapMeshes: [],
  basisInitialized: false,
  importedWatchLoaded: false,
  mobileLike: isMobileLikeDevice(),
  currentFacingMode: null,
  preferredFacingMode: null,
};

boot();

function boot() {
  initScene();
  wireEvents();
  onResize();
  state.preferredFacingMode = state.mobileLike ? "environment" : "user";
  setStageMirroring(!state.mobileLike);
  updateCameraButtons();

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(
      "Camera access requires localhost or HTTPS. Run this project through a local server instead of opening the HTML file directly.",
      "warn",
    );
    return;
  }

  clearStatus();
}

function wireEvents() {
  elements.startButton.addEventListener("click", startExperience);
  elements.debugButton.addEventListener("click", toggleDebug);
  window.addEventListener("resize", onResize);
}

async function startExperience() {
  if (state.running) {
    await stopExperience();
    return;
  }

  elements.startButton.disabled = true;
  clearStatus();

  try {
    await Promise.all([ensureHandLandmarker(), ensureCamera()]);
    state.running = true;
    updateCameraButtons();
    clearStatus();
    animate();
  } catch (error) {
    console.error(error);
    setStatus(
      "Unable to start the AR prototype. Check camera permission and network access for CDN assets.",
      "warn",
    );
    updateCameraButtons();
  }
}

async function stopExperience() {
  state.running = false;
  state.lastVideoTime = -1;
  state.framesWithoutHand = 0;
  state.smoothedPoseInitialized = false;
  state.basisInitialized = false;
  state.watchRig.visible = false;
  clearDebugCanvas();

  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      track.stop();
    }
  }

  state.stream = null;
  elements.video.srcObject = null;
  updateCameraButtons();
  clearStatus();
}

async function ensureCamera() {
  if (state.stream) {
    return;
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API unavailable. Use localhost or HTTPS.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: buildVideoConstraints(),
  });

  state.stream = stream;
  state.currentFacingMode = detectFacingModeFromTrack(stream.getVideoTracks()[0], state.preferredFacingMode);
  elements.video.srcObject = stream;
  setStageMirroring(state.currentFacingMode !== "environment");
  await elements.video.play();
  onResize();
}

function buildVideoConstraints() {
  if (state.mobileLike) {
    return {
      facingMode: { ideal: state.preferredFacingMode || "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
  }

  return {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
}

function detectFacingModeFromTrack(track, fallback) {
  const settings = track?.getSettings?.() ?? {};

  if (settings.facingMode === "environment" || settings.facingMode === "user") {
    return settings.facingMode;
  }

  return fallback || "user";
}

async function ensureHandLandmarker() {
  if (state.handLandmarker) {
    return;
  }

  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

  try {
    state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.65,
      minTrackingConfidence: 0.65,
    });
  } catch (gpuError) {
    console.warn("GPU delegate unavailable, falling back to CPU.", gpuError);
    state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: HAND_MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.65,
      minTrackingConfidence: 0.65,
    });
  }
}

function initScene() {
  state.renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setSize(elements.stage.clientWidth, elements.stage.clientHeight);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.05;
  state.renderer.domElement.style.pointerEvents = "none";
  elements.stage.appendChild(state.renderer.domElement);

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    elements.stage.clientWidth / Math.max(elements.stage.clientHeight, 1),
    0.01,
    20,
  );
  state.camera.position.set(0, 0, CAMERA_Z);
  state.camera.lookAt(0, 0, 0);

  const ambient = new THREE.HemisphereLight(0xf8f0d8, 0x1b2537, 1.7);
  const keyLight = new THREE.DirectionalLight(0xfff2d6, 2.4);
  const rimLight = new THREE.DirectionalLight(0x8cb8ff, 1.2);
  keyLight.position.set(1.8, 2.6, 3.4);
  rimLight.position.set(-2.5, 0.8, 1.1);

  state.scene.add(ambient, keyLight, rimLight);
  initWatchRig();
}

function initWatchRig() {
  const strapMaterial = new THREE.MeshStandardMaterial({
    color: 0x181c24,
    metalness: 0.18,
    roughness: 0.78,
    transparent: true,
    opacity: 1,
  });
  const strapMaterialClone = strapMaterial.clone();
  state.strapMaterials = [strapMaterial, strapMaterialClone];

  const strapGeometry = new THREE.BoxGeometry(0.44, 1.08, 0.12);
  const strapTop = new THREE.Mesh(strapGeometry, strapMaterial);
  const strapBottom = new THREE.Mesh(strapGeometry, strapMaterialClone);
  strapTop.position.y = 1.02;
  strapBottom.position.y = -1.02;
  strapTop.position.z = -0.1;
  strapBottom.position.z = -0.1;
  state.strapMeshes = [strapTop, strapBottom];

  const watchVisual = new THREE.Group();
  const watchHeadAnchor = new THREE.Group();
  const proceduralHead = buildProceduralWatchHead();

  watchHeadAnchor.add(proceduralHead);
  watchVisual.add(strapTop, strapBottom, watchHeadAnchor);

  const occluderMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
  });
  const watchOccluder = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 1.72, 0.72),
    occluderMaterial,
  );
  watchOccluder.renderOrder = -1;

  const watchRig = new THREE.Group();
  watchRig.visible = false;
  watchRig.add(watchOccluder, watchVisual);

  for (const object of [watchRig, watchVisual, watchHeadAnchor, watchOccluder]) {
    object.traverse?.((node) => {
      node.frustumCulled = false;
    });
  }

  state.watchRig = watchRig;
  state.watchVisual = watchVisual;
  state.watchHeadAnchor = watchHeadAnchor;
  state.watchOccluder = watchOccluder;
  state.proceduralHead = proceduralHead;
  state.scene.add(watchRig);

  loadWatchHeadModel();
}

function buildProceduralWatchHead() {
  const group = new THREE.Group();

  const caseMaterial = new THREE.MeshStandardMaterial({
    color: 0xcbd3df,
    metalness: 0.95,
    roughness: 0.2,
    transparent: true,
    opacity: 1,
  });
  const bezelMaterial = new THREE.MeshStandardMaterial({
    color: 0xf3b86f,
    metalness: 0.88,
    roughness: 0.25,
    transparent: true,
    opacity: 1,
  });
  const dialMaterial = new THREE.MeshStandardMaterial({
    color: 0x13212d,
    emissive: 0x0b1620,
    metalness: 0.22,
    roughness: 0.4,
    transparent: true,
    opacity: 1,
  });

  state.watchHeadMaterials = [caseMaterial, bezelMaterial, dialMaterial];

  const caseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.88, 1.12, 0.2),
    caseMaterial,
  );
  const bezelMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.08, 48),
    bezelMaterial,
  );
  const dialMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.31, 0.31, 0.04, 48),
    dialMaterial,
  );
  const crownMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.13, 18),
    bezelMaterial.clone(),
  );

  bezelMesh.rotation.x = Math.PI / 2;
  dialMesh.rotation.x = Math.PI / 2;
  bezelMesh.position.z = 0.12;
  dialMesh.position.z = 0.16;

  crownMesh.rotation.z = Math.PI / 2;
  crownMesh.position.set(0.5, 0, 0.02);

  group.add(caseMesh, bezelMesh, dialMesh, crownMesh);
  group.traverse((node) => {
    node.frustumCulled = false;
  });

  return group;
}

function loadWatchHeadModel() {
  const loader = new GLTFLoader();
  const candidatePaths = ["assets/digital_watch.glb", "assets/Watch.glb"];

  const tryLoad = (index) => {
    const path = candidatePaths[index];

    if (!path) {
      setStatus(
        "Using the built-in procedural watch. Add assets/digital_watch.glb to swap in a custom watch head.",
      );
      return;
    }

    loader.load(
      path,
      (gltf) => {
        const model = gltf.scene;

        let meshCount = 0;
        model.traverse((node) => {
          if (node.isMesh) {
            meshCount += 1;
          }
        });

        if (meshCount === 0) {
          setStatus(
            `Loaded ${path}, but it does not contain visible mesh geometry yet. Keeping the procedural watch as fallback.`,
            "warn",
          );
          return;
        }

        state.importedWatchLoaded = true;
        state.watchHeadMaterials = [];
        normalizeWatchModel(model);
        replaceWatchHead(model);
      },
      undefined,
      () => {
        tryLoad(index + 1);
      },
    );
  };

  tryLoad(0);
}

function normalizeWatchModel(model) {
  boundingBox.setFromObject(model);
  boundingBox.getSize(boxSize);
  boundingBox.getCenter(boxCenter);

  model.position.sub(boxCenter);
  model.rotation.z += IMPORTED_MODEL_ROLL_OFFSET;

  // Imported watches often include long straps, so scaling purely by model length
  // makes the dial read too small in a top/down wrist view. Blend strap length
  // with the broader case span so the face stays visually believable.
  const faceSpan = Math.max(boxSize.x, boxSize.z, 0.001);
  const weightedLength = Math.max(boxSize.y, 0.001) * IMPORTED_MODEL_LENGTH_WEIGHT;
  const referenceSpan = Math.max(faceSpan, weightedLength);
  const scaleFactor = IMPORTED_MODEL_TARGET_SPAN / referenceSpan;
  model.scale.setScalar(scaleFactor);

  model.traverse((node) => {
    node.frustumCulled = false;

    if (node.isMesh && node.material) {
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];

      for (const material of materials) {
        material.transparent = true;
        material.opacity = 1;
        state.watchHeadMaterials.push(material);
      }
    }
  });
}

function replaceWatchHead(model) {
  state.watchHeadAnchor.clear();
  state.watchHeadAnchor.add(model);
  state.proceduralHead = null;

  if (state.importedWatchLoaded) {
    for (const strapMesh of state.strapMeshes) {
      strapMesh.visible = false;
    }
  }
}

function animate() {
  if (!state.running) {
    return;
  }

  requestAnimationFrame(animate);
  renderFrame();
}

function renderFrame() {
  if (!state.handLandmarker || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    state.renderer.render(state.scene, state.camera);
    return;
  }

  resizeRendererToDisplaySize();

  if (elements.video.currentTime !== state.lastVideoTime) {
    const timestamp = performance.now();
    const results = state.handLandmarker.detectForVideo(elements.video, timestamp);
    processHandResults(results);
    state.lastVideoTime = elements.video.currentTime;
  }

  state.renderer.render(state.scene, state.camera);
}

function processHandResults(results) {
  const handIndex = selectPrimaryHand(results);

  if (handIndex === -1) {
    state.framesWithoutHand += 1;

    if (state.framesWithoutHand > HAND_LOSS_FRAMES) {
      state.watchRig.visible = false;
      state.basisInitialized = false;
      state.smoothedPoseInitialized = false;
      clearDebugCanvas();
      setStatus("Hand lost. Bring your wrist back into frame to continue tracking.");
    }

    return;
  }

  state.framesWithoutHand = 0;
  state.watchRig.visible = true;

  const landmarks = results.landmarks[handIndex];
  const worldLandmarks = results.worldLandmarks[handIndex];
  const handedness = results.handedness?.[handIndex]?.[0]?.categoryName ?? "Unknown";

  const wristLandmark = landmarks[0];
  const indexLandmark = landmarks[5];
  const pinkyLandmark = landmarks[17];
  const wrist = worldLandmarks[0];
  const midHand = worldLandmarks[9];
  const indexBase = worldLandmarks[5];
  const pinkyBase = worldLandmarks[17];

  forward
    .set(
      midHand.x - wrist.x,
      midHand.y - wrist.y,
      midHand.z - wrist.z,
    )
    .normalize();
  width
    .set(pinkyBase.x - indexBase.x, pinkyBase.y - indexBase.y, pinkyBase.z - indexBase.z)
    .normalize();

  orthogonalWidth.copy(width).addScaledVector(forward, -width.dot(forward)).normalize();
  normal.copy(forward).cross(orthogonalWidth).normalize();

  if (!Number.isFinite(normal.lengthSq()) || normal.lengthSq() < 0.5) {
    return;
  }

  const palmFacing = inferPalmFacing(wristLandmark, indexLandmark, pinkyLandmark, handedness);
  const targetDepth = THREE.MathUtils.clamp(-wrist.z * 7.5, -0.22, 0.4);

  mapLandmarkToWorld(landmarks[0], targetDepth, worldAnchor);
  tempVectorB.copy(state.camera.position).sub(worldAnchor).normalize();

  // Landmark 9 provides a steadier "hand forward" direction for the watch band
  // than the wrist edge alone; we then push the watch back toward the forearm.
  projectedForward.copy(forward).multiplyScalar(-1);

  // Keep the watch on the dorsal side of the wrist. Top view already looks good,
  // so we only resolve the ambiguous side-view normal sign using camera relation.
  projectedNormal.copy(normal);
  const normalFacingCamera = projectedNormal.dot(tempVectorB);
  const shouldFaceCamera = !palmFacing;

  if ((shouldFaceCamera && normalFacingCamera < 0) || (!shouldFaceCamera && normalFacingCamera > 0)) {
    projectedNormal.multiplyScalar(-1);
  }

  projectedWidth.crossVectors(projectedForward, projectedNormal).normalize();

  stabilizeBasis();

  mapLandmarkToWorld(landmarks[5], targetDepth, projectedIndexBaseWorld);
  mapLandmarkToWorld(landmarks[17], targetDepth, projectedPinkyBaseWorld);

  const wristWidthWorld = projectedIndexBaseWorld.distanceTo(projectedPinkyBaseWorld) * 0.76;
  const scaleValue = THREE.MathUtils.clamp(
    wristWidthWorld * WATCH_SCALE_MULTIPLIER,
    WATCH_SCALE_MIN,
    WATCH_SCALE_MAX,
  );

  targetPosition.copy(worldAnchor);
  targetPosition.addScaledVector(projectedForward, scaleValue * WRIST_BACK_OFFSET);
  targetPosition.addScaledVector(projectedNormal, scaleValue * WRIST_SURFACE_OFFSET);

  basisMatrix.makeBasis(projectedWidth, projectedForward, projectedNormal);
  targetQuaternion.setFromRotationMatrix(basisMatrix);
  targetScale.setScalar(scaleValue);

  const facingAmount = THREE.MathUtils.clamp(Math.abs(projectedNormal.z), 0, 1);
  const sideVisibility = 1 - Math.min(facingAmount * 1.35, 1);
  const backVisibility = palmFacing
    ? THREE.MathUtils.clamp(0.22 + sideVisibility * 0.28, 0.22, 0.5)
    : THREE.MathUtils.clamp(0.68 + facingAmount * 0.32, 0.68, 1);

  updateWatchPose(targetPosition, targetQuaternion, targetScale);
  updateVisibility(backVisibility, sideVisibility, palmFacing);
  updateOccluder(scaleValue);
  drawDebugHand(landmarks, palmFacing ? -1 : 1);

  const poseState =
    palmFacing ? (sideVisibility > 0.42 ? "side-angle" : "palm-side") : "back-of-hand";
  if (poseState && handedness) {
    clearStatus();
  }
}

function stabilizeBasis() {
  if (!state.basisInitialized) {
    previousForward.copy(projectedForward);
    previousNormal.copy(projectedNormal);
    state.basisInitialized = true;
    return;
  }

  if (projectedForward.dot(previousForward) < 0) {
    projectedForward.multiplyScalar(-1);
  }

  if (projectedNormal.dot(previousNormal) < 0) {
    projectedNormal.multiplyScalar(-1);
  }

  previousForward.lerp(projectedForward, BASIS_VECTOR_SMOOTHING).normalize();
  previousNormal.lerp(projectedNormal, BASIS_VECTOR_SMOOTHING).normalize();

  projectedForward.copy(previousForward);
  projectedNormal.copy(previousNormal);
  projectedWidth.crossVectors(projectedForward, projectedNormal).normalize();

  previousForward.copy(projectedForward);
  previousNormal.copy(projectedNormal);
}

function inferPalmFacing(wrist, indexBase, pinkyBase, handedness) {
  const cross2D =
    (indexBase.x - wrist.x) * (pinkyBase.y - wrist.y) -
    (indexBase.y - wrist.y) * (pinkyBase.x - wrist.x);

  if (handedness === "Left") {
    return cross2D > 0;
  }

  if (handedness === "Right") {
    return cross2D < 0;
  }

  return cross2D > 0;
}

function selectPrimaryHand(results) {
  if (!results?.landmarks?.length) {
    return -1;
  }

  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let index = 0; index < results.landmarks.length; index += 1) {
    const landmarks = results.landmarks[index];
    const spanX = Math.abs(landmarks[17].x - landmarks[5].x);
    const spanY = Math.abs(landmarks[17].y - landmarks[5].y);
    const score = spanX + spanY;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function mapLandmarkToWorld(landmark, targetZ, output) {
  const ndcX = landmark.x * 2 - 1;
  const ndcY = -(landmark.y * 2 - 1);

  rayPoint.set(ndcX, ndcY, 0.5).unproject(state.camera);
  rayDirection.copy(rayPoint).sub(state.camera.position).normalize();

  const distance = (targetZ - state.camera.position.z) / rayDirection.z;

  output
    .copy(state.camera.position)
    .addScaledVector(rayDirection, distance);

  return output;
}

function updateWatchPose(nextPosition, nextQuaternion, nextScale) {
  if (!state.smoothedPoseInitialized) {
    state.watchRig.position.copy(nextPosition);
    state.watchRig.quaternion.copy(nextQuaternion);
    state.watchVisual.scale.copy(nextScale);
    state.smoothedPoseInitialized = true;
    return;
  }

  state.watchRig.position.lerp(nextPosition, POSITION_SMOOTHING);
  state.watchRig.quaternion.slerp(nextQuaternion, ROTATION_SMOOTHING);
  state.watchVisual.scale.lerp(nextScale, SCALE_SMOOTHING);
}

function updateVisibility(backVisibility, sideVisibility, palmFacing) {
  state.palmMix = THREE.MathUtils.lerp(state.palmMix, 1 - backVisibility, 0.18);
  state.sideMix = THREE.MathUtils.lerp(state.sideMix, sideVisibility, 0.18);

  const headOpacity = state.importedWatchLoaded
    ? palmFacing
      ? THREE.MathUtils.clamp(0.34 + sideVisibility * 0.34, 0.28, 0.72)
      : THREE.MathUtils.clamp(0.86 + sideVisibility * 0.14, 0.86, 1)
    : THREE.MathUtils.clamp(0.24 + sideVisibility * 0.28 + backVisibility * 0.22, 0.18, 1);
  const strapOpacity = THREE.MathUtils.clamp(
    0.76 + sideVisibility * 0.18 - (palmFacing ? 0.08 : 0),
    0.68,
    1,
  );

  for (const material of state.watchHeadMaterials) {
    material.transparent = headOpacity < 0.995;
    material.depthWrite = headOpacity >= 0.995;
    material.opacity = headOpacity;
  }

  for (const material of state.strapMaterials) {
    material.opacity = strapOpacity;
  }
}

function updateOccluder(scaleValue) {
  state.watchOccluder.position.set(0, 0.22, -scaleValue * 0.34);
  state.watchOccluder.scale.set(scaleValue * 0.9, scaleValue * 1.26, scaleValue * 0.8);
}

function drawDebugHand(landmarks, normalZ) {
  if (!state.debugVisible) {
    clearDebugCanvas();
    return;
  }

  const widthPx = elements.debugCanvas.width;
  const heightPx = elements.debugCanvas.height;

  debugContext.clearRect(0, 0, widthPx, heightPx);
  debugContext.lineWidth = 2;
  debugContext.strokeStyle = "rgba(242, 178, 97, 0.8)";
  debugContext.fillStyle = "rgba(255, 255, 255, 0.95)";

  for (const [startIndex, endIndex] of HAND_CONNECTIONS) {
    const start = landmarks[startIndex];
    const end = landmarks[endIndex];

    debugContext.beginPath();
    debugContext.moveTo(start.x * widthPx, start.y * heightPx);
    debugContext.lineTo(end.x * widthPx, end.y * heightPx);
    debugContext.stroke();
  }

  for (const landmark of landmarks) {
    debugContext.beginPath();
    debugContext.arc(landmark.x * widthPx, landmark.y * heightPx, 4, 0, Math.PI * 2);
    debugContext.fill();
  }

  const wrist = landmarks[0];
  debugContext.beginPath();
  debugContext.arc(wrist.x * widthPx, wrist.y * heightPx, 8, 0, Math.PI * 2);
  debugContext.strokeStyle = normalZ > 0 ? "rgba(109, 225, 175, 0.92)" : "rgba(255, 140, 105, 0.92)";
  debugContext.lineWidth = 3;
  debugContext.stroke();
}

function clearDebugCanvas() {
  debugContext.clearRect(0, 0, elements.debugCanvas.width, elements.debugCanvas.height);
}

function resizeRendererToDisplaySize() {
  const widthPx = elements.stage.clientWidth;
  const heightPx = elements.stage.clientHeight;

  if (
    state.renderer.domElement.width !== Math.floor(widthPx * state.renderer.getPixelRatio()) ||
    state.renderer.domElement.height !== Math.floor(heightPx * state.renderer.getPixelRatio())
  ) {
    state.renderer.setSize(widthPx, heightPx, false);
    state.camera.aspect = widthPx / Math.max(heightPx, 1);
    state.camera.updateProjectionMatrix();
  }

  if (elements.debugCanvas.width !== widthPx || elements.debugCanvas.height !== heightPx) {
    elements.debugCanvas.width = widthPx;
    elements.debugCanvas.height = heightPx;
  }
}

function onResize() {
  resizeRendererToDisplaySize();
}

function toggleDebug() {
  state.debugVisible = !state.debugVisible;
  elements.debugButton.textContent = state.debugVisible ? "Hide debug" : "Show debug";

  if (!state.debugVisible) {
    clearDebugCanvas();
  }
}

function setStatus(message, tone = "default") {
  elements.statusText.textContent = message;
  elements.statusText.dataset.tone = tone;
  elements.statusPill.hidden = !message;
}

function updateCameraButtons() {
  elements.startButton.disabled = false;
  elements.startButton.textContent = state.running ? "Stop camera" : "Start camera";
}

function setStageMirroring(mirrored) {
  elements.stage.classList.toggle("stage--mirrored", mirrored);
}

function isMobileLikeDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
}

function clearStatus() {
  elements.statusText.textContent = "";
  elements.statusText.dataset.tone = "default";
  elements.statusPill.hidden = true;
}
