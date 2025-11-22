// app.js - Robust MediaPipe Pose + palm-triggered 3s countdown capture + measurement prototype
// Ensure these script tags are present in index.html BEFORE this file:
// <script src="https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"></script>   <-- recommended
// <script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"></script>
// <script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js"></script>

(() => {
    // DOM
    const video = document.getElementById("video");
    const overlay = document.getElementById("overlay");
    const ctx = overlay && overlay.getContext ? overlay.getContext("2d") : null;
  
    const captureBtn = document.getElementById("captureBtn");
    const measureBtn = document.getElementById("measureBtn");
    const resetBtn = document.getElementById("resetBtn");
    const statusBar = document.getElementById("status");
  
    const chestEl = document.getElementById("chest");
    const shoulderEl = document.getElementById("shoulder");
    const armEl = document.getElementById("arm");
    const waistEl = document.getElementById("waist");
    const suggestionBox = document.getElementById("suggestions");
  
    // State
    let capturedImage = null;
    let lastPose = null;
    let poseInstance = null;
    let handsInstance = null;
    let cameraInstance = null;
  
    // palm trigger cooldown (ms)
    let palmTriggerCooldown = false;
  
    // create floating countdown element (bottom-right)
    const countdownEl = document.createElement("div");
    countdownEl.id = "countdownFloat";
    Object.assign(countdownEl.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      width: "72px",
      height: "72px",
      borderRadius: "40px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "28px",
      fontWeight: "700",
      color: "#fff",
      background: "linear-gradient(135deg, rgba(76,201,240,0.18), rgba(58,12,163,0.25))",
      boxShadow: "0 8px 24px rgba(0,0,0,0.6), 0 0 18px rgba(76,201,240,0.12) inset",
      backdropFilter: "blur(6px)",
      zIndex: "9999",
      pointerEvents: "none",
      transform: "scale(0.95)",
      transition: "transform 0.18s ease",
    });
    countdownEl.style.display = "none";
    document.body.appendChild(countdownEl);
  
    function status(msg) {
      if (statusBar) statusBar.textContent = "Status: " + msg;
      console.log("[STATUS]", msg);
    }
    function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
  
    // ---------- Utilities ----------
    function drawPoseDebug(results) {
      if (!ctx) return;
      try {
        // we don't clear here to avoid removing other overlays when needed
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        // optionally draw the live camera frame behind landmarks
        ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
        if (results && results.poseLandmarks && window.drawConnectors && window.drawLandmarks) {
          drawConnectors(ctx, results.poseLandmarks, Pose.POSE_CONNECTIONS, { color: "#00ffd0", lineWidth: 2 });
          drawLandmarks(ctx, results.poseLandmarks, { color: "#ff0066", lineWidth: 1 });
        }
      } catch (e) {
        console.warn("drawPoseDebug error", e);
      }
    }
  
    // Heuristic: detect open palm from hand landmarks (one hand).
    // Expects one hand's landmarks array (21 points normalized coordinates).
    function isOpenPalm(handLandmarks) {
      if (!handLandmarks || handLandmarks.length < 21) return false;
  
      // landmark indices (MediaPipe Hands): 0 = wrist, tips = 4,8,12,16,20
      const wrist = handLandmarks[0];
      const tips = [handLandmarks[4], handLandmarks[8], handLandmarks[12], handLandmarks[16], handLandmarks[20]];
  
      // compute average distance wrist -> tip
      let sum = 0;
      let valid = 0;
      for (const t of tips) {
        if (!t) continue;
        const dx = t.x - wrist.x;
        const dy = t.y - wrist.y;
        const d = Math.hypot(dx, dy);
        sum += d;
        valid++;
      }
      if (valid === 0) return false;
      const avg = sum / valid;
  
      // estimate hand box size (max tip-tip distance) to normalize
      let maxD = 0;
      for (let i = 0; i < tips.length; i++) {
        for (let j = i + 1; j < tips.length; j++) {
          if (!tips[i] || !tips[j]) continue;
          const dx = tips[i].x - tips[j].x;
          const dy = tips[i].y - tips[j].y;
          maxD = Math.max(maxD, Math.hypot(dx, dy));
        }
      }
      if (maxD === 0) return avg > 0.06; // fallback
  
      const ratio = avg / maxD;
      // tuned threshold — open palm tends to have ratio ~0.45+
      return ratio > 0.42;
    }
  
    // ---------- Camera + Models init ----------
    async function initCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 1280, height: 720 },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
  
        // hide raw video, draw only on canvas
        if (video.style) video.style.display = "none";
        if (overlay.style) { overlay.style.display = "block"; overlay.style.position = "relative"; overlay.style.zIndex = 1; }
  
        overlay.width = video.videoWidth || 1280;
        overlay.height = video.videoHeight || 720;
  
        initializeModelsAndCamera();
      } catch (err) {
        status("Camera error: " + (err && err.message));
        console.error("initCamera error", err);
      }
    }
  
    function initializeModelsAndCamera() {
      if (typeof Pose === "undefined" || typeof Camera === "undefined") {
        status("MediaPipe Pose or Camera not loaded. Check your script tags.");
        console.error("MediaPipe Pose/Camera globals missing.");
        return;
      }
  
      try {
        // Pose
        poseInstance = new Pose({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
        poseInstance.setOptions({ modelComplexity: 1, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
        poseInstance.onResults((results) => {
          lastPose = results.poseLandmarks || null;
          drawPoseDebug(results);
        });
  
        // Hands (optional but recommended)
        if (typeof Hands !== "undefined") {
          handsInstance = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
          handsInstance.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
        } else {
          status("Hands model not loaded — include hands.js if you want palm trigger.");
          console.warn("Hands global missing. Palm trigger disabled until you add hands.js script.");
        }
  
        if (handsInstance) {
          handsInstance.onResults((handResults) => {
            try {
              const multi = handResults.multiHandLandmarks || [];
              if (multi.length > 0) {
                // draw hand on top of canvas (optional)
                try {
                  drawConnectors(ctx, multi[0], Hands.HAND_CONNECTIONS, { color: "#ffd166", lineWidth: 2 });
                  drawLandmarks(ctx, multi[0], { color: "#ffd166", lineWidth: 1 });
                } catch (e) { /* ignore drawing errors */ }
  
                // palm detection: trigger capture if open palm and not in cooldown
                if (!palmTriggerCooldown && isOpenPalm(multi[0])) {
                  palmTriggerCooldown = true;
                  // start capture sequence (reuses same countdown)
                  startCaptureSequence();
                  // cooldown to avoid repeated triggers; user can show palm again after cooldown
                  setTimeout(() => { palmTriggerCooldown = false; }, 3000);
                }
              }
            } catch (e) {
              console.warn("hands onResults error", e);
            }
          });
        }
  
        // Single Camera to feed both models
        cameraInstance = new Camera(video, {
          onFrame: async () => {
            try {
              if (poseInstance) await poseInstance.send({ image: video });
              if (handsInstance) await handsInstance.send({ image: video });
            } catch (e) {
              // ignore per-frame errors
            }
          },
          width: 1280,
          height: 720,
        });
        cameraInstance.start();
        status("Pose model initialized. Hands " + (handsInstance ? "enabled" : "disabled") + ".");
      } catch (e) {
        status("Failed to initialize models.");
        console.error("initializeModelsAndCamera error", e);
      }
    }
  
    // ---------- Capture flow (single function used by button and palm) ----------
    // prevents overlapping capture attempts
    let _captureInProgress = false;
  
    async function startCaptureSequence() {
      if (_captureInProgress) return;
      _captureInProgress = true;
  
      let timeLeft = 3;
      countdownEl.textContent = timeLeft;
      countdownEl.style.display = "flex";
      countdownEl.style.transform = "scale(1)";
      countdownEl.animate([{ transform: "scale(0.9)", opacity: 0.8 }, { transform: "scale(1)", opacity: 1 }], { duration: 220, easing: "ease-out" });
  
      const countdown = setInterval(async () => {
        timeLeft--;
        if (timeLeft > 0) {
          countdownEl.textContent = timeLeft;
          countdownEl.style.transform = "scale(1.02)";
          setTimeout(() => (countdownEl.style.transform = "scale(1)"), 120);
        } else {
          clearInterval(countdown);
          countdownEl.style.display = "none";
          try {
            // draw current video frame to overlay and capture
            ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
            capturedImage = overlay.toDataURL("image/png");
            status("Image captured. Detecting pose on captured image...");
  
            // run pose on captured canvas so snapshot's landmarks are computed
            if (poseInstance && typeof poseInstance.send === "function") {
              try {
                await poseInstance.send({ image: overlay });
                status("Pose detected on captured image.");
              } catch (err) {
                status("Pose detection failed on captured image.");
                console.error("pose on captured image error:", err);
              }
            } else {
              status("Pose model not ready yet.");
            }
          } catch (err) {
            status("Capture failed: " + (err && err.message));
            console.error("capture error", err);
          } finally {
            _captureInProgress = false;
          }
        }
      }, 1000);
    }
  
    // attach capture button to the unified capture function
    if (captureBtn) captureBtn.addEventListener("click", startCaptureSequence);
  
    // ---------- upper body detection ----------
    function isUpperBodyVisible() {
      if (!lastPose) return false;
      const shoulderL = lastPose[11];
      const shoulderR = lastPose[12];
      const hipL = lastPose[23];
      const hipR = lastPose[24];
      if (!shoulderL || !shoulderR || !hipL || !hipR) return false;
  
      if (typeof shoulderL.visibility !== "undefined") {
        if (shoulderL.visibility < 0.35 || shoulderR.visibility < 0.35 || hipL.visibility < 0.35 || hipR.visibility < 0.35) return false;
      }
      if (!(shoulderL.y < hipL.y && shoulderR.y < hipR.y)) return false;
      return true;
    }
  
    // ---------- measurement ----------
    if (measureBtn) {
      measureBtn.addEventListener("click", () => {
        if (!capturedImage) {
          status("Capture an image first.");
          return;
        }
        // note: after startCaptureSequence we call poseInstance.send({image: overlay}) which updates lastPose
        if (!isUpperBodyVisible()) {
          status("❌ Error: Upper body not detected. Stand straight and ensure shoulders + torso visible.");
          chestEl.textContent = "—";
          shoulderEl.textContent = "—";
          armEl.textContent = "—";
          waistEl.textContent = "—";
          suggestionBox.innerHTML = "";
          return;
        }
        measureBody();
      });
    }
  
    // Fake measurement & Indian suggestion logic (placeholders for now)
    function measureBody() {
      const chest = randomRange(85, 110);
      const shoulder = randomRange(38, 55);
      const arm = randomRange(52, 65);
      const waist = randomRange(70, 105);
  
      if (chestEl) chestEl.textContent = chest + " cm";
      if (shoulderEl) shoulderEl.textContent = shoulder + " cm";
      if (armEl) armEl.textContent = arm + " cm";
      if (waistEl) waistEl.textContent = waist + " cm";
  
      suggestClothes(chest, waist);
      status("Measurement complete.");
    }
  
    function suggestClothes(chest, waist) {
      if (!suggestionBox) return;
      suggestionBox.innerHTML = "";
      let base = getSizeIndian(chest);
      if (waist > chest - 10) {
        const sizes = ["S", "M", "L", "XL", "XXL"];
        const idx = sizes.indexOf(base);
        if (idx < sizes.length - 1) base = sizes[idx + 1];
      }
      const map = { S: "36 (S)", M: "38 (M)", L: "40 (L)", XL: "42 (XL)", XXL: "44 (XXL)" };
      const suggestions = [
        `Recommended Size (India): <b>${map[base]}</b>`,
        `T-Shirts: ${base} (Indian cut) — Slim/regular fit`,
        `Shirts: ${base} (choose ${base} Regular or Comfort)`,
        `Kurtas / Ethnic: ${base} — consider one size up for loose fit`,
        `Jackets: ${base} (try on for shoulders)`,
      ];
      suggestions.forEach((t) => {
        const d = document.createElement("div");
        d.className = "suggestion-item";
        d.innerHTML = t;
        suggestionBox.appendChild(d);
      });
    }
  
    function getSizeIndian(chestCm) {
      if (chestCm <= 92) return "S";
      if (chestCm <= 98) return "M";
      if (chestCm <= 104) return "L";
      if (chestCm <= 110) return "XL";
      return "XXL";
    }
  
    function randomRange(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  
    // Reset
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
        capturedImage = null;
        chestEl && (chestEl.textContent = "—");
        shoulderEl && (shoulderEl.textContent = "—");
        armEl && (armEl.textContent = "—");
        waistEl && (waistEl.textContent = "—");
        suggestionBox && (suggestionBox.innerHTML = "");
        status("Reset complete.");
      });
    }
  
    // Start
    window.addEventListener("load", initCamera);
  })();
  