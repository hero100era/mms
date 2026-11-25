-- Session defaults for the login roles. Application roles also run with an
-- empty search_path so every reference must be schema-qualified.

alter role mms_owner set search_path = '';
alter role migrator set search_path = '';
alter role authenticator set search_path = '';
alter role auth_gateway set search_path = '';
alter role worker set search_path = '';
alter role audit_sealer set search_path = '';

alter role migrator set statement_timeout = 0;
alter role mms_owner set statement_timeout = 0;
alter role authenticator set statement_timeout = '30s';
alter role auth_gateway set statement_timeout = '10s';
alter role worker set statement_timeout = '5min';
alter role audit_sealer set statement_timeout = '5min';

alter role authenticator set idle_in_transaction_session_timeout = '30s';
alter role auth_gateway set idle_in_transaction_session_timeout = '10s';
alter role worker set idle_in_transaction_session_timeout = '60s';
alter role audit_sealer set idle_in_transaction_session_timeout = '60s';

-- pgaudit configuration for DDL migration auditing (Card H-02).
alter role migrator set pgaudit.log = 'ddl, role';

