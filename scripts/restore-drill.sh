#!/usr/bin/env bash
# Card H-12: database restore drill.
#
# Dumps the configured database, restores it into a scratch database, and then proves the
# restored copy is the thing we think it is: the pgTAP invariants pass against it (which
# covers grants, RLS, authority rules, sessions, audit triggers and the sealing chain) and
# the Tier-2 seal chain verifies against the WORM store.
#
# The point of a drill is that it is rehearsed before it is needed. It is deliberately
# mechanical and destructive only to the scratch database it creates.
#
# Usage:
#   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/mms_dev ./scripts/restore-drill.sh
#
# Environment:
#   DATABASE_URL            source database (required)
#   RESTORE_DRILL_DATABASE  scratch database name (default: mms_restore_drill)
#   MMS_SEALER_DATABASE_URL connection for the sealer role, used by db:verify
#   MMS_WORM_DIR            WORM directory the verifier should read

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required, for example postgresql://postgres@localhost:5432/mms_dev" >&2
  exit 1
fi

SCRATCH_DB="${RESTORE_DRILL_DATABASE:-mms_restore_drill}"

# Robust URL parsing preserving query params (e.g. ?host=/tmp, ?sslmode=require)
PARSED_URLS=$(node -e '
  try {
    const rawUrl = process.argv[1];
    const targetDb = process.argv[2];
    const u = new URL(rawUrl);
    const sourceDb = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    u.pathname = "/" + encodeURIComponent(targetDb);
    console.log(sourceDb);
    console.log(u.toString());
  } catch (err) {
    console.error("Invalid DATABASE_URL format:", err.message);
    process.exit(1);
  }
' "$DATABASE_URL" "$SCRATCH_DB")

SOURCE_DB=$(echo "$PARSED_URLS" | head -n 1)
SCRATCH_URL=$(echo "$PARSED_URLS" | tail -n 1)

if [[ "$SCRATCH_DB" == "$SOURCE_DB" ]]; then
  echo "Restore drill FAILED: scratch database '$SCRATCH_DB' cannot match source database '$SOURCE_DB'" >&2
  exit 1
fi

if [[ ! "$SCRATCH_DB" =~ ^[a-zA-Z0-9_]+(_drill|_scratch|_restore)$ ]]; then
  echo "Restore drill FAILED: scratch database '$SCRATCH_DB' must be a safe SQL identifier ending in _drill, _scratch, or _restore" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/mms-restore-drill.XXXXXX")"
DUMP_FILE="$WORKDIR/source.dump"
STARTED_AT="$(date +%s)"

cleanup() {
  echo "Dropping scratch database $SCRATCH_DB"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c "drop database if exists \"$SCRATCH_DB\" with (force)" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "1/5 Dumping $DATABASE_URL"
# Ownership and ACLs are part of the dump on purpose: a restore that loses grants and
# owners produces a database whose tests fail for reasons that have nothing to do with the
# data, and the drill would then be testing pg_dump rather than our recovery procedure.
pg_dump "$DATABASE_URL" --format=custom --file="$DUMP_FILE"
echo "    dump size: $(du -h "$DUMP_FILE" | cut -f1)"

echo "2/5 Creating scratch database $SCRATCH_DB"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "drop database if exists \"$SCRATCH_DB\" with (force)" >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "create database \"$SCRATCH_DB\"" >/dev/null

echo "3/5 Restoring into $SCRATCH_DB"
pg_restore --dbname="$SCRATCH_URL" --exit-on-error "$DUMP_FILE"

echo "4/5 Verifying the restored copy (pgTAP invariants against $SCRATCH_DB)"
DATABASE_URL="$SCRATCH_URL" npm run db:verify

echo "5/5 Verifying the Tier-2 seal chain against the WORM store"
SEAL_COUNT=$(psql "$SCRATCH_URL" -tAc "select count(*) from audit_trail.seal")
if [[ "$SEAL_COUNT" -eq 0 ]]; then
  echo "    no seals in the source database yet; the chain check has nothing to compare"
else
  if [[ -n "${MMS_SEALER_DATABASE_URL:-}" ]]; then
    SEALER_SCRATCH_URL="$(node -e "
      const u = new URL(process.argv[1]);
      u.pathname = '/' + process.argv[2];
      console.log(u.toString());
    " "$MMS_SEALER_DATABASE_URL" "$SCRATCH_DB")"
  else
    SEALER_SCRATCH_URL="$SCRATCH_URL"
  fi
  VERIFY_OUTPUT=$(DATABASE_URL="$SCRATCH_URL" \
    AUDIT_SEALER_DATABASE_URL="$SEALER_SCRATCH_URL" \
    MMS_SEALER_DATABASE_URL="$SEALER_SCRATCH_URL" \
    npm run audit_trail:verify 2>&1)
  echo "$VERIFY_OUTPUT" | tail -12
  # A verifier that analyzes zero seals prints the same reassuring sentence as one that
  # analyzed every seal, so a mismatched MMS_WORM_DIR would look like a pass. Tie the
  # result to the number of seals the restored database actually holds.
  ANALYZED=$(echo "$VERIFY_OUTPUT" | sed -n "s/^Total Seals Analyzed *: *\\([0-9][0-9]*\\).*/\\1/p" | head -1)
  if [[ -z "$ANALYZED" || "$ANALYZED" -lt "$SEAL_COUNT" ]]; then
    echo "Restore drill FAILED: database has $SEAL_COUNT seal(s) but the verifier analysed ${ANALYZED:-0}." >&2
    echo "Check that MMS_WORM_DIR points at the store the sealer wrote to." >&2
    exit 1
  fi
  echo "    chain verified: $ANALYZED seal(s)"
fi

ELAPSED=$(( $(date +%s) - STARTED_AT ))
echo
echo "Restore drill passed in ${ELAPSED}s ($DUMP_FILE restored into $SCRATCH_DB)"
echo "Record this in the drill log with the dump size, elapsed time and verifier result."
