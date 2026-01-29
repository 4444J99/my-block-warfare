# TurfSynth AR - Unity Client

Unity client for the TurfSynth AR location-based game.

## Requirements

- Unity 2022.3 LTS or later (2023.x recommended)
- AR Foundation 5.x
- ARKit XR Plugin (iOS) or ARCore XR Plugin (Android)
- .NET Standard 2.1

## Setup

### 1. Create Unity Project

1. Open Unity Hub
2. Create new 3D project (URP recommended for mobile)
3. Copy the `Assets/` folder contents into your project's `Assets/` folder

### 2. Install Required Packages

Open Package Manager (Window > Package Manager) and install:

```
com.unity.xr.arfoundation
com.unity.xr.arkit (iOS)
com.unity.xr.arcore (Android)
com.unity.inputsystem
```

### 3. Configure AR

1. Edit > Project Settings > XR Plug-in Management
2. Enable ARKit (iOS tab) and ARCore (Android tab)
3. Player Settings > iOS: Add Camera and Location Usage Description
4. Player Settings > Android: Set minimum API level to 26+

### 4. Scene Setup

Create a new scene with:

1. AR Session (GameObject > XR > AR Session)
2. AR Session Origin (GameObject > XR > AR Session Origin)
3. Empty GameObject with `ApiClient` component
4. Empty GameObject with `LocationService` component
5. Add `ARSessionManager` to AR Session object
6. Add `FingerprintCapture` to any persistent object

### 5. Configure API Client

Select the ApiClient GameObject and set:
- **Base URL**: `http://localhost:3000` (dev) or your production server

## Project Structure

```
Assets/
├── Scripts/
│   ├── Networking/
│   │   ├── ApiClient.cs       # HTTP client for backend
│   │   └── LocationService.cs # GPS + location validation
│   ├── AR/
│   │   └── ARSessionManager.cs # AR Foundation wrapper
│   ├── Fingerprint/
│   │   └── FingerprintCapture.cs # Place fingerprint extraction
│   ├── Turf/                   # Territory mechanics (TODO)
│   └── Synthlings/             # Creature system (TODO)
├── Shaders/                    # Procedural visual shaders
├── Prefabs/                    # Reusable GameObjects
├── Scenes/                     # Game scenes
└── Resources/                  # Runtime-loaded assets
```

## API Integration

The client communicates with the Node.js backend via REST API:

### Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/location/validate` | Validate player location |
| `POST /api/v1/fingerprint/submit` | Submit place fingerprint |
| `GET /api/v1/turf/cell/:h3` | Get cell territory info |
| `POST /api/v1/turf/raid` | Initiate territory raid |

### Authentication

Set auth token after user login:

```csharp
ApiClient.Instance.SetAuthToken(token, userId, sessionId);
```

## Development

### Running Locally

1. Start the backend server: `npm run dev` in the root directory
2. Set ApiClient base URL to `http://localhost:3000`
3. Build to device (AR requires physical device)

### Debugging

- Enable verbose logging in ApiClient for HTTP debugging
- Use Unity Remote for faster iteration
- Check Location Services are enabled on device

## Build Notes

### iOS

1. Requires Xcode 14+
2. Add `NSCameraUsageDescription` to Info.plist
3. Add `NSLocationWhenInUseUsageDescription` to Info.plist
4. Sign with Apple Developer account

### Android

1. Target API 26+ (Android 8.0)
2. Enable ARCore Support in Player Settings
3. Add camera and location permissions to manifest

## Next Steps

- [ ] Implement Synthling rendering and animations
- [ ] Add turf visualization on AR planes
- [ ] Implement raid mechanics UI
- [ ] Add crew management screens
- [ ] Integrate push notifications
