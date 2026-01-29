# TurfSynth AR Operations Runbook

## Quick Reference

### Service Health Checks

```bash
# Check server health
curl http://localhost:3000/health

# Check location validation service
curl http://localhost:3000/api/v1/location/health

# Check fingerprint stats
curl http://localhost:3000/api/v1/fingerprint/stats
```

### Database Operations

```bash
# Run migrations
npm run db:migrate

# Seed test data
npm run db:seed

# Connect to PostgreSQL
psql $DATABASE_URL
```

### Redis Operations

```bash
# Connect to Redis
redis-cli -u $REDIS_URL

# Check cache stats
redis-cli INFO stats

# Clear all caches (DANGER: production impact)
redis-cli FLUSHALL
```

---

## Periodic Tasks

### Every 15 Minutes

1. **Influence Decay Processing**
   ```sql
   SELECT process_influence_decay(0.995);
   ```

2. **Outpost Tick Processing**
   ```sql
   SELECT process_outpost_ticks();
   ```

### Daily

1. **Zone Data Sync** (if using OSM)
   - Monitor sync job status
   - Review error logs for failed imports

2. **Generate Daily Contracts**
   ```sql
   SELECT generate_district_contracts(district_id) FROM districts;
   ```

3. **Update Crew Statistics**
   ```sql
   UPDATE crews SET ... -- Run update_crew_stats for each crew
   ```

### Weekly

1. **Cache Cleanup**
   ```sql
   DELETE FROM h3_cell_zone_cache WHERE expires_at < NOW();
   ```

2. **Partition Management**
   ```sql
   SELECT drop_old_validation_partitions(6);
   ```

3. **Index Maintenance**
   ```sql
   REINDEX TABLE location_validations;
   REINDEX TABLE fingerprints;
   ```

---

## Monitoring Alerts

### Critical (Page On-Call)

| Metric | Threshold | Action |
|--------|-----------|--------|
| Location validation p95 | >200ms | Check DB/Redis |
| Error rate | >1% | Review logs |
| Spoof detection rate | >5% | Manual review |
| Database connections | >90% pool | Scale or optimize |

### Warning (Next Business Day)

| Metric | Threshold | Action |
|--------|-----------|--------|
| Cache hit rate | <90% | Review warm strategy |
| Zone data freshness | >7 days | Trigger sync |
| Fingerprint submission rate | -50% | Check client issues |

---

## Common Issues

### High Location Validation Latency

**Symptoms**: p95 >100ms, increased timeouts

**Diagnosis**:
```sql
-- Check slow queries
SELECT * FROM pg_stat_activity WHERE state = 'active' AND wait_event IS NOT NULL;

-- Check cache hit rate
SELECT localCacheSize FROM h3_cache_stats;
```

**Resolution**:
1. Check Redis connectivity
2. Verify H3 cache is warmed
3. Review recent zone data changes
4. Scale read replicas if needed

### GPS Spoof Wave

**Symptoms**: Spike in spoof_score > 0.7 users

**Diagnosis**:
```sql
SELECT COUNT(*) FROM spoof_scores WHERE current_score > 0.7;
SELECT user_id, current_score, total_flags FROM spoof_scores
ORDER BY current_score DESC LIMIT 20;
```

**Response**:
1. Do NOT auto-ban (per constitution)
2. Review flagged accounts manually
3. Adjust detection thresholds if false positives
4. Communicate with players if widespread

### Zone Data Gaps

**Symptoms**: Users blocked in valid areas, or playing in restricted areas

**Diagnosis**:
```sql
-- Find zones by area
SELECT name, category, source FROM exclusion_zones
WHERE ST_Contains(geometry, ST_SetSRID(ST_MakePoint($lng, $lat), 4326));

-- Check zone data freshness
SELECT source, COUNT(*), MAX(updated_at) FROM exclusion_zones GROUP BY source;
```

**Resolution**:
1. For missing zones: Add via admin API with source='manual'
2. For false zones: Set effective_until to expire them
3. Trigger OSM re-sync for area

---

## Scaling Procedures

### Adding Read Replicas

1. Create replica in cloud console
2. Update `DATABASE_URL` to use connection pooler
3. Configure read/write splitting in application

### Redis Cluster Mode

1. Set `REDIS_CLUSTER_MODE=true`
2. Update Redis URL to cluster endpoint
3. Restart services

### Horizontal API Scaling

1. Increase replica count in k8s deployment
2. Verify load balancer health checks pass
3. Monitor connection pool usage

---

## Emergency Procedures

### Full Service Outage

1. Check cloud provider status page
2. Verify database connectivity
3. Verify Redis connectivity
4. Check application logs for crash loops
5. Rollback recent deployments if needed

### Database Recovery

1. Identify last known good backup
2. Restore to point-in-time if needed
3. Verify data integrity
4. Replay any missing events from Redis

### Security Incident

1. Isolate affected systems
2. Preserve logs and evidence
3. Notify security team
4. Follow incident response playbook

---

## API Quick Reference

### Location Validation
```bash
curl -X POST http://localhost:3000/api/v1/location/validate \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "uuid",
    "sessionId": "uuid",
    "coordinates": {"latitude": 37.7749, "longitude": -122.4194},
    "timestamp": "2024-01-01T00:00:00Z"
  }'
```

### Fingerprint Submission
```bash
curl -X POST http://localhost:3000/api/v1/fingerprint/submit \
  -H "Content-Type: application/json" \
  -H "X-User-ID: uuid" \
  -d '{
    "fingerprint": {...},
    "sessionId": "uuid"
  }'
```

### Territory Snapshot
```bash
curl "http://localhost:3000/api/v1/turf/snapshot?lat=37.7749&lng=-122.4194" \
  -H "X-User-ID: uuid" \
  -H "X-Crew-ID: uuid"
```

---

## Contact

- **On-Call**: Check PagerDuty schedule
- **Escalation**: engineering-leads@turfsynth.ar
- **Security**: security@turfsynth.ar
