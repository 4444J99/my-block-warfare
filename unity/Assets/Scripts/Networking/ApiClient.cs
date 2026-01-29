using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace TurfSynth.Networking
{
    /// <summary>
    /// HTTP client for communicating with the TurfSynth AR backend.
    /// Handles authentication, request signing, and response parsing.
    /// </summary>
    public class ApiClient : MonoBehaviour
    {
        private static ApiClient _instance;
        public static ApiClient Instance => _instance;

        [Header("Configuration")]
        [SerializeField] private string baseUrl = "http://localhost:3000";
        [SerializeField] private float timeoutSeconds = 30f;

        private string _authToken;
        private string _sessionId;
        private string _userId;

        public bool IsAuthenticated => !string.IsNullOrEmpty(_authToken);
        public string SessionId => _sessionId;
        public string UserId => _userId;

        public event Action<string> OnAuthenticationChanged;
        public event Action<ApiError> OnApiError;

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
        /// Set the authentication token for API requests.
        /// </summary>
        public void SetAuthToken(string token, string userId, string sessionId)
        {
            _authToken = token;
            _userId = userId;
            _sessionId = sessionId;
            OnAuthenticationChanged?.Invoke(userId);
        }

        /// <summary>
        /// Clear authentication state.
        /// </summary>
        public void ClearAuth()
        {
            _authToken = null;
            _userId = null;
            _sessionId = null;
            OnAuthenticationChanged?.Invoke(null);
        }

        /// <summary>
        /// Send a GET request to the API.
        /// </summary>
        public async Task<ApiResponse<T>> GetAsync<T>(string endpoint, Dictionary<string, string> queryParams = null)
        {
            var url = BuildUrl(endpoint, queryParams);
            using var request = UnityWebRequest.Get(url);
            return await SendRequestAsync<T>(request);
        }

        /// <summary>
        /// Send a POST request to the API.
        /// </summary>
        public async Task<ApiResponse<T>> PostAsync<T>(string endpoint, object body)
        {
            var url = BuildUrl(endpoint);
            var json = JsonUtility.ToJson(body);
            var bodyBytes = Encoding.UTF8.GetBytes(json);

            using var request = new UnityWebRequest(url, "POST");
            request.uploadHandler = new UploadHandlerRaw(bodyBytes);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");

            return await SendRequestAsync<T>(request);
        }

        /// <summary>
        /// Send a PUT request to the API.
        /// </summary>
        public async Task<ApiResponse<T>> PutAsync<T>(string endpoint, object body)
        {
            var url = BuildUrl(endpoint);
            var json = JsonUtility.ToJson(body);
            var bodyBytes = Encoding.UTF8.GetBytes(json);

            using var request = new UnityWebRequest(url, "PUT");
            request.uploadHandler = new UploadHandlerRaw(bodyBytes);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");

            return await SendRequestAsync<T>(request);
        }

        /// <summary>
        /// Send a DELETE request to the API.
        /// </summary>
        public async Task<ApiResponse<T>> DeleteAsync<T>(string endpoint)
        {
            var url = BuildUrl(endpoint);
            using var request = UnityWebRequest.Delete(url);
            request.downloadHandler = new DownloadHandlerBuffer();
            return await SendRequestAsync<T>(request);
        }

        private string BuildUrl(string endpoint, Dictionary<string, string> queryParams = null)
        {
            var url = $"{baseUrl}{endpoint}";

            if (queryParams != null && queryParams.Count > 0)
            {
                var queryString = new StringBuilder("?");
                foreach (var param in queryParams)
                {
                    queryString.Append($"{Uri.EscapeDataString(param.Key)}={Uri.EscapeDataString(param.Value)}&");
                }
                url += queryString.ToString().TrimEnd('&');
            }

            return url;
        }

        private async Task<ApiResponse<T>> SendRequestAsync<T>(UnityWebRequest request)
        {
            // Set common headers
            request.SetRequestHeader("Accept", "application/json");

            if (!string.IsNullOrEmpty(_authToken))
            {
                request.SetRequestHeader("Authorization", $"Bearer {_authToken}");
            }

            if (!string.IsNullOrEmpty(_sessionId))
            {
                request.SetRequestHeader("X-Session-ID", _sessionId);
            }

            request.timeout = (int)timeoutSeconds;

            // Send request
            var operation = request.SendWebRequest();

            while (!operation.isDone)
            {
                await Task.Yield();
            }

            // Parse response
            var response = new ApiResponse<T>
            {
                StatusCode = (int)request.responseCode,
                IsSuccess = request.result == UnityWebRequest.Result.Success,
            };

            if (response.IsSuccess && request.downloadHandler != null)
            {
                try
                {
                    var responseText = request.downloadHandler.text;
                    response.Data = JsonUtility.FromJson<T>(responseText);
                    response.RawResponse = responseText;
                }
                catch (Exception ex)
                {
                    Debug.LogError($"[ApiClient] Failed to parse response: {ex.Message}");
                    response.IsSuccess = false;
                    response.Error = new ApiError
                    {
                        Code = "PARSE_ERROR",
                        Message = "Failed to parse server response"
                    };
                }
            }
            else
            {
                response.Error = new ApiError
                {
                    Code = request.result.ToString(),
                    Message = request.error ?? "Unknown error",
                    StatusCode = (int)request.responseCode
                };

                // Try to parse error body
                if (request.downloadHandler != null && !string.IsNullOrEmpty(request.downloadHandler.text))
                {
                    try
                    {
                        var errorResponse = JsonUtility.FromJson<ApiErrorResponse>(request.downloadHandler.text);
                        if (errorResponse != null)
                        {
                            response.Error.Code = errorResponse.code;
                            response.Error.Message = errorResponse.message;
                        }
                    }
                    catch
                    {
                        // Keep original error
                    }
                }

                OnApiError?.Invoke(response.Error);
            }

            return response;
        }

        /// <summary>
        /// Configure the API client with a new base URL.
        /// </summary>
        public void Configure(string newBaseUrl)
        {
            if (!string.IsNullOrEmpty(newBaseUrl))
            {
                baseUrl = newBaseUrl.TrimEnd('/');
            }
        }
    }

    /// <summary>
    /// Generic API response wrapper.
    /// </summary>
    [Serializable]
    public class ApiResponse<T>
    {
        public bool IsSuccess;
        public int StatusCode;
        public T Data;
        public ApiError Error;
        public string RawResponse;
    }

    /// <summary>
    /// API error information.
    /// </summary>
    [Serializable]
    public class ApiError
    {
        public string Code;
        public string Message;
        public int StatusCode;
    }

    /// <summary>
    /// Error response from the server.
    /// </summary>
    [Serializable]
    internal class ApiErrorResponse
    {
        public string code;
        public string message;
    }
}
