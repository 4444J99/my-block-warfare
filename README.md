# TurfSynth AR

## The Problem

Location-based games lack true environmental synthesis — they overlay static content on the real world rather than generating unique experiences from the player's actual surroundings.

## The Approach

TurfSynth AR extracts "Place Fingerprints" (compact environmental feature vectors) from camera, microphone, and sensors to procedurally generate creatures, soundscapes, and visuals that are unique to each location.

## The Outcome

A turf-control game where your neighborhood literally builds the game around you — every block sounds and looks like itself, and every player's experience is different.

---

## Core Loop

```
┌─────────────────────────────────────────────────────────────────┐
│   Player walks into cell                                        │
│        │                                                        │
│        ▼                                                        │
│   Location validated (Safety Geofencing) ─── Fails? ──▶ Blocked │
│        │                                                        │
│        ▼ Passes                                                 │
│   Extract fingerprint (Place Fingerprint)                       │
│        │                                                        │
│        ├──▶ Submit fingerprint ──▶ +10 Influence                │
│        │                                                        │
│        └──▶ Encounter Synthling (procedural creature)           │
│                  │                                              │
│                  ▼                                              │
│             Capture ──▶ +5 Influence + Add to Collection        │
│                                                                 │
│   [Passive] Influence decays hourly                             │
│   [Async]   Raid rival outposts                                 │
│   [Goal]    Control districts, evolve Synthlings                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Unity Client                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ AR Session   │  │  Fingerprint │  │    Turf      │          │
│  │ Manager      │  │   Capture    │  │   Display    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ REST API (shared/api-types.ts)
┌───────────────────────────┴─────────────────────────────────────┐
│                     Node.js Backend (Fastify)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Geofencing  │  │  Fingerprint │  │     Turf     │          │
│  │   Service    │  │   Service    │  │   Service    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│          │                 │                 │                  │
│  ┌───────┴─────────────────┴─────────────────┴───────┐         │
│  │              PostgreSQL + PostGIS                  │         │
│  │                    Redis                           │         │
│  └────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

### Backend Services

| Service | Purpose | Key Files |
|---------|---------|-----------|
| **Geofencing** | GPS validation, exclusion zones (schools/hospitals), spoof detection | `src/services/geofencing/` |
| **Fingerprint** | Process place fingerprints (color, audio, motion) | `src/services/fingerprint/` |
| **Turf** | Influence tracking, outpost management, raid resolution | `src/services/turf/` |

### Unity Client

| Component | Purpose | Key Files |
|-----------|---------|-----------|
| **AR Session** | AR Foundation setup, camera/sensor access | `unity/Assets/Scripts/AR/` |
| **Fingerprint Capture** | Extract environmental features | `unity/Assets/Scripts/Fingerprint/` |
| **Networking** | API client, location service | `unity/Assets/Scripts/Networking/` |

---

## Getting Started

### Prerequisites

- Node.js 22+
- PostgreSQL 16+ with PostGIS extension
- Redis 7+
- Unity 2022.3 LTS (for client development)

### Backend Setup

```bash
# Clone and install
git clone https://github.com/your-org/turfsynth-ar.git
cd turfsynth-ar
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your database credentials

# Run migrations
npm run db:migrate

# Start development server
npm run dev
```

### Environment Variables

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/turfsynth
REDIS_URL=redis://localhost:6379
LOG_LEVEL=debug
NODE_ENV=development
```

### Running Tests

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific test file
npm run test -- src/__tests__/unit/influence-manager.test.ts
```

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run test` | Run test suite (Vitest) |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Check code style (ESLint) |
| `npm run lint:fix` | Auto-fix lint errors |
| `npm run typecheck` | Run TypeScript type checker |
| `npm run db:migrate` | Run database migrations |

---

## API Reference

### Location Validation

```http
POST /api/v1/location/validate
Content-Type: application/json

{
  "userId": "uuid",
  "sessionId": "uuid",
  "latitude": 37.7749,
  "longitude": -122.4194,
  "accuracy": 10,
  "timestamp": "2024-01-15T10:30:00Z",
  "platform": "ios"
}
```

### Fingerprint Submission

```http
POST /api/v1/fingerprint/submit
Content-Type: application/json

{
  "h3Cell": "89283082813ffff",
  "colorPalette": [{"r": 120, "g": 85, "b": 200}],
  "dominantColor": {"r": 120, "g": 85, "b": 200},
  "brightness": 0.65,
  "audioFeatures": {
    "ambientLevel": 0.4,
    "frequency": 440,
    "complexity": 0.3
  }
}
```

### Turf Status

```http
GET /api/v1/turf/cell/:h3Index
GET /api/v1/turf/district/:districtId/leaderboard
POST /api/v1/turf/raid
```

See `shared/api-types.ts` for complete TypeScript type definitions.

---

## Project Structure

```
turfsynth-ar/
├── src/                          # Backend source
│   ├── api/v1/                   # REST endpoints
│   ├── services/                 # Business logic
│   │   ├── geofencing/           # Safety & validation
│   │   ├── fingerprint/          # Place fingerprint processing
│   │   └── turf/                 # Territory mechanics
│   ├── db/                       # Database connection & migrations
│   ├── types/                    # TypeScript type definitions
│   └── __tests__/                # Test suite (59 unit tests)
├── shared/                       # Shared API contract types
├── unity/                        # Unity AR client
│   └── Assets/Scripts/           # C# client code
├── specs/                        # Feature specifications
└── .github/workflows/            # CI/CD pipeline
```

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Spatial indexing** | H3 (Uber) | Consistent hexagonal cells, efficient neighbor queries |
| **Database** | PostgreSQL + PostGIS | Mature geospatial support, JSONB for flexible schemas |
| **API framework** | Fastify | Performance, TypeScript support, schema validation |
| **AR Client** | Unity + AR Foundation | Cross-platform ARKit/ARCore, high-quality rendering |
| **Real-time** | Redis | Pub/sub for live updates, caching for hot data |

---

## Privacy & Safety

- **Place Fingerprints only**: Store/transmit low-dimensional feature vectors, never raw camera/audio
- **Exclusion zones**: Server-side geofencing blocks play near schools, hospitals, private residences
- **Spoof detection**: GPS validation, speed limits, behavioral analysis
- **No live tracking**: All multiplayer interactions are async; no real-time player locations shared

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Write tests for new functionality
4. Ensure all tests pass (`npm run test`)
5. Commit changes (`git commit -m 'Add amazing feature'`)
6. Push to branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

---

## License

[License TBD]

---

## Roadmap

### Completed (Week 1)
- [x] Unit tests for core services (59 tests)
- [x] CI/CD pipeline with GitHub Actions
- [x] Unity project structure with AR Foundation
- [x] Shared API type definitions
- [x] ESLint flat config for TypeScript

### In Progress (Week 2)
- [ ] Integration tests for API endpoints
- [ ] Unity API client implementation
- [ ] AR session management
- [ ] Fingerprint capture on device

### Upcoming
- [ ] Synthling generation service
- [ ] Real-time influence updates (WebSocket)
- [ ] Alpha pilot deployment
