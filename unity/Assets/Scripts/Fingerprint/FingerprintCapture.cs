using System;
using System.Threading.Tasks;
using UnityEngine;
using TurfSynth.Networking;
using TurfSynth.AR;

namespace TurfSynth.Fingerprint
{
    /// <summary>
    /// Captures place fingerprints from the device camera and sensors.
    /// Extracts environmental features for procedural content generation.
    /// </summary>
    public class FingerprintCapture : MonoBehaviour
    {
        private static FingerprintCapture _instance;
        public static FingerprintCapture Instance => _instance;

        [Header("Capture Settings")]
        [SerializeField] private int captureResolution = 256;
        [SerializeField] private float captureTimeout = 5f;
        [SerializeField] private float minCaptureCooldown = 1f;

        [Header("Color Extraction")]
        [SerializeField] private int colorPaletteSize = 5;
        [SerializeField] private int samplesPerColor = 100;

        private bool _isCapturing;
        private DateTime _lastCaptureTime;
        private Texture2D _captureTexture;

        public bool IsCapturing => _isCapturing;
        public bool CanCapture => !_isCapturing &&
            (DateTime.UtcNow - _lastCaptureTime).TotalSeconds >= minCaptureCooldown;

        public event Action<PlaceFingerprint> OnFingerprintCaptured;
        public event Action<string> OnCaptureError;
        public event Action<float> OnCaptureProgress;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;

            _captureTexture = new Texture2D(captureResolution, captureResolution, TextureFormat.RGB24, false);
        }

        /// <summary>
        /// Capture a place fingerprint at the current location.
        /// </summary>
        public async Task<PlaceFingerprint> CaptureAsync()
        {
            if (_isCapturing)
            {
                OnCaptureError?.Invoke("Capture already in progress");
                return null;
            }

            if (!CanCapture)
            {
                OnCaptureError?.Invoke("Please wait before capturing again");
                return null;
            }

            _isCapturing = true;
            OnCaptureProgress?.Invoke(0f);

            try
            {
                // Step 1: Validate location
                OnCaptureProgress?.Invoke(0.1f);
                var validation = await LocationService.Instance.ValidateLocationAsync();

                if (!validation.valid)
                {
                    OnCaptureError?.Invoke($"Location not valid: {validation.resultCode}");
                    return null;
                }

                // Step 2: Capture camera frame
                OnCaptureProgress?.Invoke(0.3f);
                var colorPalette = await CaptureColorPaletteAsync();

                if (colorPalette == null || colorPalette.Length == 0)
                {
                    OnCaptureError?.Invoke("Failed to capture camera image");
                    return null;
                }

                // Step 3: Get AR environment data
                OnCaptureProgress?.Invoke(0.5f);
                var envInfo = ARSessionManager.Instance?.GetEnvironmentInfo() ?? default;

                // Step 4: Capture audio features (placeholder)
                OnCaptureProgress?.Invoke(0.7f);
                var audioFeatures = CaptureAudioFeatures();

                // Step 5: Build fingerprint
                OnCaptureProgress?.Invoke(0.9f);
                var fingerprint = new PlaceFingerprint
                {
                    h3Cell = validation.h3Cell,
                    timestamp = DateTime.UtcNow.ToString("O"),
                    colorPalette = colorPalette,
                    dominantColor = colorPalette.Length > 0 ? colorPalette[0] : new ColorRGB(),
                    brightness = envInfo.LightEstimation.AmbientBrightness,
                    colorTemperature = envInfo.LightEstimation.ColorTemperature,
                    planeCount = envInfo.PlaneCount,
                    audioFeatures = audioFeatures,
                    motionSignature = CaptureMotionSignature(),
                };

                // Step 6: Submit to server
                var result = await SubmitFingerprintAsync(fingerprint);

                if (result.success)
                {
                    _lastCaptureTime = DateTime.UtcNow;
                    OnCaptureProgress?.Invoke(1f);
                    OnFingerprintCaptured?.Invoke(fingerprint);
                    return fingerprint;
                }

                OnCaptureError?.Invoke($"Server rejected fingerprint: {result.message}");
                return null;
            }
            catch (Exception ex)
            {
                OnCaptureError?.Invoke($"Capture failed: {ex.Message}");
                return null;
            }
            finally
            {
                _isCapturing = false;
            }
        }

        private async Task<ColorRGB[]> CaptureColorPaletteAsync()
        {
            // Get camera texture
            var camera = Camera.main;
            if (camera == null) return Array.Empty<ColorRGB>();

            // Create render texture
            var rt = RenderTexture.GetTemporary(captureResolution, captureResolution, 24);
            camera.targetTexture = rt;
            camera.Render();

            // Read pixels
            RenderTexture.active = rt;
            _captureTexture.ReadPixels(new Rect(0, 0, captureResolution, captureResolution), 0, 0);
            _captureTexture.Apply();

            // Cleanup
            camera.targetTexture = null;
            RenderTexture.active = null;
            RenderTexture.ReleaseTemporary(rt);

            // Extract dominant colors using k-means clustering (simplified)
            await Task.Yield(); // Allow frame to continue
            return ExtractDominantColors(_captureTexture);
        }

        private ColorRGB[] ExtractDominantColors(Texture2D texture)
        {
            var pixels = texture.GetPixels();
            var colorCounts = new System.Collections.Generic.Dictionary<Color32, int>();

            // Sample pixels
            var step = Mathf.Max(1, pixels.Length / (samplesPerColor * colorPaletteSize));
            for (int i = 0; i < pixels.Length; i += step)
            {
                var color = (Color32)pixels[i];
                // Quantize color to reduce unique colors
                color.r = (byte)(color.r / 32 * 32);
                color.g = (byte)(color.g / 32 * 32);
                color.b = (byte)(color.b / 32 * 32);

                if (colorCounts.ContainsKey(color))
                    colorCounts[color]++;
                else
                    colorCounts[color] = 1;
            }

            // Sort by frequency and take top colors
            var sortedColors = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<Color32, int>>(colorCounts);
            sortedColors.Sort((a, b) => b.Value.CompareTo(a.Value));

            var result = new ColorRGB[Mathf.Min(colorPaletteSize, sortedColors.Count)];
            for (int i = 0; i < result.Length; i++)
            {
                var c = sortedColors[i].Key;
                result[i] = new ColorRGB { r = c.r, g = c.g, b = c.b };
            }

            return result;
        }

        private AudioFeatures CaptureAudioFeatures()
        {
            // Placeholder: Would use Microphone class for actual audio capture
            return new AudioFeatures
            {
                ambientLevel = 0.5f,
                frequency = 440f,
                complexity = 0.3f,
            };
        }

        private MotionSignature CaptureMotionSignature()
        {
            var gyro = Input.gyro;
            var accel = Input.acceleration;

            return new MotionSignature
            {
                rotationX = gyro.attitude.x,
                rotationY = gyro.attitude.y,
                rotationZ = gyro.attitude.z,
                accelerationMagnitude = accel.magnitude,
            };
        }

        private async Task<FingerprintSubmitResult> SubmitFingerprintAsync(PlaceFingerprint fingerprint)
        {
            var response = await ApiClient.Instance.PostAsync<FingerprintSubmitResult>(
                "/api/v1/fingerprint/submit",
                fingerprint
            );

            if (response.IsSuccess)
            {
                return response.Data;
            }

            return new FingerprintSubmitResult
            {
                success = false,
                message = response.Error?.Message ?? "Unknown error",
            };
        }

        private void OnDestroy()
        {
            if (_captureTexture != null)
            {
                Destroy(_captureTexture);
            }
        }
    }

    /// <summary>
    /// Place fingerprint data structure matching backend expectations.
    /// </summary>
    [Serializable]
    public class PlaceFingerprint
    {
        public string h3Cell;
        public string timestamp;
        public ColorRGB[] colorPalette;
        public ColorRGB dominantColor;
        public float brightness;
        public float colorTemperature;
        public int planeCount;
        public AudioFeatures audioFeatures;
        public MotionSignature motionSignature;
    }

    /// <summary>
    /// RGB color representation.
    /// </summary>
    [Serializable]
    public struct ColorRGB
    {
        public byte r;
        public byte g;
        public byte b;
    }

    /// <summary>
    /// Audio features from ambient sound.
    /// </summary>
    [Serializable]
    public struct AudioFeatures
    {
        public float ambientLevel;
        public float frequency;
        public float complexity;
    }

    /// <summary>
    /// Motion/orientation signature.
    /// </summary>
    [Serializable]
    public struct MotionSignature
    {
        public float rotationX;
        public float rotationY;
        public float rotationZ;
        public float accelerationMagnitude;
    }

    /// <summary>
    /// Result from fingerprint submission.
    /// </summary>
    [Serializable]
    public class FingerprintSubmitResult
    {
        public bool success;
        public string message;
        public string fingerprintId;
        public int influenceAwarded;
    }
}
