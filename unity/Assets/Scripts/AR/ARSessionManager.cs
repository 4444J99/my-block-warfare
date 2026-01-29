using System;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace TurfSynth.AR
{
    /// <summary>
    /// Manages AR session lifecycle and configuration.
    /// Handles AR Foundation setup, tracking state, and environmental understanding.
    /// </summary>
    [RequireComponent(typeof(ARSession))]
    public class ARSessionManager : MonoBehaviour
    {
        private static ARSessionManager _instance;
        public static ARSessionManager Instance => _instance;

        [Header("AR Components")]
        [SerializeField] private ARSession arSession;
        [SerializeField] private ARCameraManager arCameraManager;
        [SerializeField] private ARPlaneManager arPlaneManager;
        [SerializeField] private ARRaycastManager arRaycastManager;
        [SerializeField] private AROcclusionManager arOcclusionManager;

        [Header("Configuration")]
        [SerializeField] private bool enablePlaneDetection = true;
        [SerializeField] private bool enableOcclusion = true;
        [SerializeField] private PlaneDetectionMode planeDetectionMode = PlaneDetectionMode.Horizontal;

        private ARSessionState _currentState = ARSessionState.None;
        private bool _isInitialized;

        public ARSession Session => arSession;
        public ARCameraManager CameraManager => arCameraManager;
        public ARPlaneManager PlaneManager => arPlaneManager;
        public ARRaycastManager RaycastManager => arRaycastManager;
        public bool IsTracking => _currentState == ARSessionState.SessionTracking;
        public bool IsInitialized => _isInitialized;

        public event Action<ARSessionState> OnSessionStateChanged;
        public event Action OnTrackingStarted;
        public event Action OnTrackingLost;
        public event Action<string> OnARError;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        private void OnEnable()
        {
            ARSession.stateChanged += OnARSessionStateChanged;

            if (arCameraManager != null)
            {
                arCameraManager.frameReceived += OnCameraFrameReceived;
            }

            if (arPlaneManager != null)
            {
                arPlaneManager.planesChanged += OnPlanesChanged;
            }
        }

        private void OnDisable()
        {
            ARSession.stateChanged -= OnARSessionStateChanged;

            if (arCameraManager != null)
            {
                arCameraManager.frameReceived -= OnCameraFrameReceived;
            }

            if (arPlaneManager != null)
            {
                arPlaneManager.planesChanged -= OnPlanesChanged;
            }
        }

        private void Start()
        {
            InitializeAR();
        }

        /// <summary>
        /// Initialize the AR session with configured settings.
        /// </summary>
        public void InitializeAR()
        {
            if (_isInitialized) return;

            // Validate required components
            if (arSession == null)
            {
                arSession = FindObjectOfType<ARSession>();
                if (arSession == null)
                {
                    OnARError?.Invoke("ARSession component not found");
                    return;
                }
            }

            // Configure plane detection
            if (arPlaneManager != null)
            {
                arPlaneManager.enabled = enablePlaneDetection;
                arPlaneManager.requestedDetectionMode = planeDetectionMode;
            }

            // Configure occlusion
            if (arOcclusionManager != null)
            {
                arOcclusionManager.enabled = enableOcclusion;
            }

            _isInitialized = true;
            Debug.Log("[ARSessionManager] AR session initialized");
        }

        /// <summary>
        /// Reset the AR session, clearing all tracking data.
        /// </summary>
        public void ResetSession()
        {
            if (arSession != null)
            {
                arSession.Reset();
                Debug.Log("[ARSessionManager] AR session reset");
            }
        }

        /// <summary>
        /// Pause the AR session.
        /// </summary>
        public void PauseSession()
        {
            if (arSession != null)
            {
                arSession.enabled = false;
                Debug.Log("[ARSessionManager] AR session paused");
            }
        }

        /// <summary>
        /// Resume the AR session.
        /// </summary>
        public void ResumeSession()
        {
            if (arSession != null)
            {
                arSession.enabled = true;
                Debug.Log("[ARSessionManager] AR session resumed");
            }
        }

        /// <summary>
        /// Toggle plane detection on/off.
        /// </summary>
        public void SetPlaneDetection(bool enabled)
        {
            enablePlaneDetection = enabled;
            if (arPlaneManager != null)
            {
                arPlaneManager.enabled = enabled;

                // Hide existing planes if disabled
                if (!enabled)
                {
                    foreach (var plane in arPlaneManager.trackables)
                    {
                        plane.gameObject.SetActive(false);
                    }
                }
            }
        }

        /// <summary>
        /// Toggle occlusion on/off.
        /// </summary>
        public void SetOcclusion(bool enabled)
        {
            enableOcclusion = enabled;
            if (arOcclusionManager != null)
            {
                arOcclusionManager.enabled = enabled;
            }
        }

        /// <summary>
        /// Get the current camera pose for fingerprint capture.
        /// </summary>
        public Pose GetCameraPose()
        {
            if (arCameraManager != null && arCameraManager.transform != null)
            {
                return new Pose(
                    arCameraManager.transform.position,
                    arCameraManager.transform.rotation
                );
            }
            return Pose.identity;
        }

        /// <summary>
        /// Check if AR is supported on this device.
        /// </summary>
        public static bool IsARSupported()
        {
            return ARSession.state != ARSessionState.Unsupported &&
                   ARSession.state != ARSessionState.NeedsInstall;
        }

        private void OnARSessionStateChanged(ARSessionStateChangedEventArgs args)
        {
            var previousState = _currentState;
            _currentState = args.state;

            Debug.Log($"[ARSessionManager] Session state: {previousState} -> {_currentState}");
            OnSessionStateChanged?.Invoke(_currentState);

            switch (_currentState)
            {
                case ARSessionState.SessionTracking:
                    if (previousState != ARSessionState.SessionTracking)
                    {
                        OnTrackingStarted?.Invoke();
                    }
                    break;

                case ARSessionState.SessionInitializing:
                case ARSessionState.Ready:
                    // Still initializing
                    break;

                case ARSessionState.Unsupported:
                    OnARError?.Invoke("AR is not supported on this device");
                    break;

                case ARSessionState.NeedsInstall:
                    OnARError?.Invoke("AR software needs to be installed");
                    break;

                default:
                    if (previousState == ARSessionState.SessionTracking)
                    {
                        OnTrackingLost?.Invoke();
                    }
                    break;
            }
        }

        private void OnCameraFrameReceived(ARCameraFrameEventArgs args)
        {
            // Camera frame processing for fingerprint capture
            // The actual capture is handled by FingerprintCapture component
        }

        private void OnPlanesChanged(ARPlanesChangedEventArgs args)
        {
            // Plane detection updates
            // Used for placing Synthlings and outposts
        }

        /// <summary>
        /// Get information about the current AR environment.
        /// </summary>
        public AREnvironmentInfo GetEnvironmentInfo()
        {
            return new AREnvironmentInfo
            {
                PlaneCount = arPlaneManager != null ? arPlaneManager.trackables.count : 0,
                IsTracking = IsTracking,
                SessionState = _currentState.ToString(),
                LightEstimation = GetLightEstimation(),
            };
        }

        private LightEstimationData GetLightEstimation()
        {
            var data = new LightEstimationData();

            if (arCameraManager != null && arCameraManager.TryGetComponent<Light>(out var light))
            {
                data.AmbientBrightness = light.intensity;
                data.ColorTemperature = light.colorTemperature;
            }

            return data;
        }
    }

    /// <summary>
    /// Information about the current AR environment.
    /// </summary>
    [Serializable]
    public struct AREnvironmentInfo
    {
        public int PlaneCount;
        public bool IsTracking;
        public string SessionState;
        public LightEstimationData LightEstimation;
    }

    /// <summary>
    /// Light estimation data from AR.
    /// </summary>
    [Serializable]
    public struct LightEstimationData
    {
        public float AmbientBrightness;
        public float ColorTemperature;
    }
}
