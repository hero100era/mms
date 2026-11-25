# ADR-0014: Audit retention classes, crypto-shredding, and partitioning spike & policy

- Status: accepted (Card H-03)
- Date: 2026-10-31

## Context

MMS is subject to conflicting legal, regulatory, and evidentiary regimes:
1. **Statutory Maritime Safety Mandates**:
   - Under IMO RO Code §3.8.2 and IACS PR17, classification societies must retain technical ship records, survey reports, condition of class (CoC) histories, and statutory certificates for the operating life of the vessel plus an archive period (minimum 30 years).
   - In accordance with Decision Q6 and `docs/compliance/evidence-requirements.md` §3, MMS defines 7 distinct statutory record classes (`RC-1` through `RC-7`).
2. **Data Privacy Rights vs. Evidentiary Immutability**:
   - EU GDPR Article 17 ("Right to Erasure") and China PIPL Article 47 grant individuals the right to have personal identifiers erased upon departure or request.
   - However, in Tier 1 and Tier 2 audit architecture (ADR-0007, ADR-0012), audit change logs and sealed WORM object storage blobs are protected by cryptographic hash chains (`seal_hash`) and Merkle trees. Physical row deletion or in-place redaction of historical events would alter JSON Lines payloads, causing SHA-256 batch digests and verification chains to fail.
3. **Partitioning Evaluation (Card H-03)**:
   - Section 8.1, 8.5, and 12.5 of `docs/plans/auth-implementation-plan.md` stipulate: ordinary (non-partitioned) tables Day One; partitioning only if G2 volumes require it, supported by an empirical pgschema spike for partitioned tables, partition indexes, and inherited triggers.

## Decision

Implement the Tier-2 retention and privacy architecture across three integrated pillars:

### 1. Statutory Retention Classes & Lifecycle Pruning (Decision Q6)

1. **Declarative Catalogs (`audit_trail.retention_class` & `audit_trail.table_retention_policy`)**:
   - Establishes the 7 statutory retention classes defined in Milestone G2:
     - `RC-1` (IAM & Security Logs): 7 years statutory (Active DB 2 yrs → Cold Archive 5 yrs); crypto-shred eligible.
     - `RC-2` (Operational Surveys & Triage): 10 years statutory (Active DB 5 yrs → Cold Archive); exempt from erasure under GDPR Art 17(3)(b).
     - `RC-3` (Technical Ship Data & Plan Approvals): 30 years (Life of vessel + 5 yrs); cold immutable storage.
     - `RC-4` (Issued Certificates): 30 years (Life of vessel + 5 yrs); cold immutable storage.
     - `RC-5` (Row-Level Audit Change Log): 30 years statutory (Active DB 2 yrs → WORM); crypto-shred eligible for personal data fields.
     - `RC-6` (Administrative Events): 7 years statutory (Active DB 3 yrs → Cold Archive).
     - `RC-7` (Schema Changes & Migration Ledgers): Perpetual (Life of MMS + 10 yrs); never pruned.
2. **Pruning Safeguards (`private.purge_sealed_audit_records`)**:
   - Records may ONLY be pruned from the active database if they have already been sealed into `audit_trail.seal` (`tx_id < max_sealed_xid`) and exported to immutable WORM object storage.
   - Pruning executes exclusively through security definer function `private.purge_sealed_audit_records` using transaction-local authorization guard `mms.retention_purge_allowed = 'true'`.
   - Append-only triggers `change_log_append_only` and `event_append_only` strictly block any unprivileged or direct `DELETE` statement.
   - Every purge run is recorded in `audit_trail.retention_purge_run` and emits an operational audit event (`audit_trail.retention.purged`).

### 2. Cryptographic Shredding (Crypto-Shredding)

1. **Zero-Knowledge Erasure on Immutable Storage**:
   - To resolve the conflict between privacy erasure and WORM hash-chain immutability, personal data fields (PII) are encrypted before insertion using a dedicated per-subject Data Encryption Key (DEK) with AES-256-GCM.
   - DEKs are wrapped with a 256-bit master key and cataloged in `audit_trail.crypto_shred_key`.
2. **Key Destruction Lifecycle (`private.shred_subject_key`)**:
   - When an approved erasure request is executed, `private.shred_subject_key(subject_id, reason)` permanently zeroizes the stored DEK (`SHREDDED_ZEROIZED_...`), records actor attribution and reason, and transitions key status to `shredded`.
   - Trigger `crypto_shred_key_guard` prevents any deletion of key records and enforces that a shredded key can never be modified or restored to active.
   - Once shredded, the ciphertext remaining in `audit_trail.change_log`, `audit_trail.event`, and historical sealed WORM blobs becomes mathematically unrecoverable.
   - **Crucial Evidentiary Invariant**: Because ciphertexts in historical JSONL batches are never touched, the SHA-256 batch digests, seal hash chains, and WORM storage objects remain 100% intact. The standalone compliance verifier (`verifyAuditSeals`) continues to pass with zero errors.

### 3. Partitioning Evaluation & pgschema Spike

1. **G2 Volume Assessment**:
   - MMS G2 maritime classification workloads generate an estimated 100,000 to 500,000 audit records per year (~1–2 GB/year).
   - Single PostgreSQL tables with standard B-tree indexes comfortably handle tens of millions of rows before partition boundaries yield execution or maintenance benefits.
   - With continuous Tier-2 horizon sealing exporting un-pruned batches to WORM object storage, active DB storage overhead remains bounded.
2. **pgschema Spike Results (`db/tests/pgschema/spike.ts`)**:
   - Added automated fixture `partitioned-table-indexes-triggers` to the pgschema object-coverage suite.
   - Spike findings:
     - `pgschema 1.14.1` successfully plans declarative partitioned table creation (`PARTITION BY RANGE`), child partition attachments (`PARTITION OF`), local and global partition indexes, and inherited triggers.
     - However, adding a column to a partitioned table with existing child partitions causes pgschema to emit redundant `ALTER TABLE <child> ADD COLUMN` statements, which PostgreSQL rejects with `ERROR: cannot add column to a partition`.
     - Furthermore, declarative partitioning requires the partition key (`occurred_at`) in all unique constraints and primary keys (`id, occurred_at`), preventing single-column foreign key references (such as `audit_trail.reconciliation_discrepancy.change_log_id` referencing `audit_trail.change_log.id`).
3. **Partitioning Policy**:
   - **Retain unpartitioned tables for Day One production.** Single-table append-only design preserves clean foreign keys, simplifies trigger and RLS verification, avoids pgschema column-alteration failure modes, and easily satisfies G2 performance requirements.
   - If audit volumes exceed 50 million records, range partitioning can be planned as a dedicated migration with custom pre/post scripts.

## Consequences

- Evidentiary integrity is preserved: WORM archives and seal hash chains never break when GDPR or PIPL erasure requests are fulfilled.
- Personal data of departing surveyors or external contacts can be permanently crypto-shredded with cryptographic certainty.
- Regulated maritime safety records (RC-2, RC-3, RC-4) are systematically protected from improper erasure under statutory exemptions.
- Active database storage can be pruned safely without risk of data loss because only sealed, WORM-exported records are eligible for pruning.
- The repository maintains zero-drift schema discipline across all 39 migrations with automated pgschema spike coverage for partitioned tables.
