using System;
using System.Threading.Tasks;
using UnityEngine;

namespace TurfSynth.Networking
{
    /// <summary>
    /// Service for location-related API calls and device location tracking.
    /// Bridges Unity's location services with the TurfSynth backend.
    /// </summary>
    public class LocationService : MonoBehaviour
    {
        private static LocationService _instance;
        public static LocationService Instance => _instance;

        [Header("Configuration")]
        [SerializeField] private float updateIntervalSeconds = 5f;
        [SerializeField] private float desiredAccuracyMeters = 10f;
        [SerializeField] private float minDistanceUpdateMeters = 5f;

        private bool _isTracking;
        private LocationInfo _lastLocation;
        private DateTime _lastUpdateTime;

        public bool IsTracking => _isTracking;
        public LocationInfo LastLocation => _lastLocation;
        public bool HasLocation => _lastLocation.timestamp > 0;

        public event Action<LocationInfo> OnLocationUpdated;
        public event Action<LocationValidationResponse> OnLocationValidated;
        public event Action<string> OnLocationError;

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

        /// <summary>
        /// Start tracking device location.
        /// </summary>
        public async Task<bool> StartTrackingAsync()
        {
            if (_isTracking) return true;

            // Check if location services are enabled
            if (!Input.location.isEnabledByUser)
            {
                OnLocationError?.Invoke("Location services are disabled. Please enable in settings.");
                return false;
            }

            // Request permission and start service
            Input.location.Start(desiredAccuracyMeters, minDistanceUpdateMeters);

            // Wait for initialization
            int maxWaitSeconds = 20;
            while (Input.location.status == LocationServiceStatus.Initializing && maxWaitSeconds > 0)
            {
                await Task.Delay(1000);
                maxWaitSeconds--;
            }

            if (Input.location.status == LocationServiceStatus.Failed)
            {
                OnLocationError?.Invoke("Unable to determine device location.");
                return false;
            }

            if (Input.location.status == LocationServiceStatus.Running)
            {
                _isTracking = true;
                _lastLocation = Input.location.lastData;
                OnLocationUpdated?.Invoke(_lastLocation);
                StartCoroutine(TrackLocationCoroutine());
                return true;
            }

            OnLocationError?.Invoke("Location service failed to start.");
            return false;
        }

        /// <summary>
        /// Stop tracking device location.
        /// </summary>
        public void StopTracking()
        {
            _isTracking = false;
            Input.location.Stop();
            StopAllCoroutines();
        }

        private System.Collections.IEnumerator TrackLocationCoroutine()
        {
            while (_isTracking)
            {
                if (Input.location.status == LocationServiceStatus.Running)
                {
                    var newLocation = Input.location.lastData;

                    // Only update if location changed significantly
                    if (newLocation.timestamp > _lastLocation.timestamp)
                    {
                        _lastLocation = newLocation;
                        _lastUpdateTime = DateTime.UtcNow;
                        OnLocationUpdated?.Invoke(_lastLocation);
                    }
                }

                yield return new WaitForSeconds(updateIntervalSeconds);
            }
        }

        /// <summary>
        /// Validate current location with the backend.
        /// </summary>
        public async Task<LocationValidationResponse> ValidateLocationAsync()
        {
            if (!HasLocation)
            {
                return new LocationValidationResponse
                {
                    valid = false,
                    resultCode = "NO_LOCATION",
                };
            }

            var request = new LocationValidationRequest
            {
                userId = ApiClient.Instance.UserId,
                sessionId = ApiClient.Instance.SessionId,
                latitude = _lastLocation.latitude,
                longitude = _lastLocation.longitude,
                accuracy = _lastLocation.horizontalAccuracy,
                altitude = _lastLocation.altitude,
                timestamp = DateTime.UtcNow.ToString("O"),
                platform = Application.platform == RuntimePlatform.IPhonePlayer ? "ios" : "android",
            };

            var response = await ApiClient.Instance.PostAsync<LocationValidationResponse>(
                "/api/v1/location/validate",
                request
            );

            if (response.IsSuccess)
            {
                OnLocationValidated?.Invoke(response.Data);
                return response.Data;
            }

            return new LocationValidationResponse
            {
                valid = false,
                resultCode = response.Error?.Code ?? "API_ERROR",
            };
        }

        /// <summary>
        /// Get the current H3 cell from the server.
        /// </summary>
        public async Task<string> GetCurrentCellAsync()
        {
            var validation = await ValidateLocationAsync();
            return validation.valid ? validation.h3Cell : null;
        }

        /// <summary>
        /// Calculate distance to a point in meters.
        /// </summary>
        public float DistanceTo(float latitude, float longitude)
        {
            if (!HasLocation) return float.MaxValue;

            // Haversine formula
            const float R = 6371000f; // Earth radius in meters

            var lat1 = _lastLocation.latitude * Mathf.Deg2Rad;
            var lat2 = latitude * Mathf.Deg2Rad;
            var dLat = (latitude - _lastLocation.latitude) * Mathf.Deg2Rad;
            var dLon = (longitude - _lastLocation.longitude) * Mathf.Deg2Rad;

            var a = Mathf.Sin(dLat / 2) * Mathf.Sin(dLat / 2) +
                    Mathf.Cos(lat1) * Mathf.Cos(lat2) *
                    Mathf.Sin(dLon / 2) * Mathf.Sin(dLon / 2);
            var c = 2 * Mathf.Atan2(Mathf.Sqrt(a), Mathf.Sqrt(1 - a));

            return R * c;
        }

        private void OnDestroy()
        {
            StopTracking();
        }
    }

    /// <summary>
    /// Request payload for location validation.
    /// </summary>
    [Serializable]
    public class LocationValidationRequest
    {
        public string userId;
        public string sessionId;
        public float latitude;
        public float longitude;
        public float accuracy;
        public float altitude;
        public string timestamp;
        public string platform;
    }

    /// <summary>
    /// Response from location validation endpoint.
    /// </summary>
    [Serializable]
    public class LocationValidationResponse
    {
        public bool valid;
        public string resultCode;
        public string h3Cell;
        public ZoneCheckResult zoneCheck;
        public SpeedCheckResult speedCheck;
        public string requestId;
    }

    /// <summary>
    /// Zone check result from validation.
    /// </summary>
    [Serializable]
    public class ZoneCheckResult
    {
        public bool allowed;
        public BlockingZone blockedBy;
    }

    /// <summary>
    /// Blocking zone information.
    /// </summary>
    [Serializable]
    public class BlockingZone
    {
        public string zoneId;
        public string zoneName;
        public string category;
    }

    /// <summary>
    /// Speed check result from validation.
    /// </summary>
    [Serializable]
    public class SpeedCheckResult
    {
        public bool allowed;
        public float currentSpeedKmh;
        public bool isLocked;
    }
}
