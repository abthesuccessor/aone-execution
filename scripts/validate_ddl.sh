#!/usr/bin/env bash
set -euo pipefail

container_name="ege-postgres-contract-$PPID"
postgres_image="postgres@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15"
expected_postgres_version="18.4"
cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --detach \
  --name "$container_name" \
  --env POSTGRES_PASSWORD=ege-contract-test \
  "$postgres_image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready --username postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$container_name" pg_isready --username postgres >/dev/null
actual_postgres_version="$(docker exec "$container_name" postgres --version)"
if [[ "$actual_postgres_version" != *"$expected_postgres_version"* ]]; then
  echo "expected $expected_postgres_version, got $actual_postgres_version" >&2
  exit 1
fi
python3 scripts/extract_ch14_ddl.py \
  | docker exec --interactive "$container_name" \
      psql --username postgres --dbname postgres --no-psqlrc \
        --set ON_ERROR_STOP=1

echo "PostgreSQL $expected_postgres_version DDL validation passed with pinned image digest"
