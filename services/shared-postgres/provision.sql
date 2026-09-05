\set ON_ERROR_STOP on
\getenv backup_password BACKUP_ROLE_PASSWORD
\getenv foody_password FOODY_ROLE_PASSWORD
\getenv sight_password SIGHT_ROLE_PASSWORD
\getenv skyline_password SKYLINE_ROLE_PASSWORD
\getenv docs_password DOCS_ROLE_PASSWORD
CREATE ROLE ocd_backup LOGIN PASSWORD :'backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
GRANT pg_read_all_data TO ocd_backup;
CREATE ROLE foody_owner LOGIN PASSWORD :'foody_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE sight_owner LOGIN PASSWORD :'sight_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE skyline_owner LOGIN PASSWORD :'skyline_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE sight_docs_owner LOGIN PASSWORD :'docs_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE foody OWNER foody_owner;
CREATE DATABASE sight OWNER sight_owner;
CREATE DATABASE skyline OWNER skyline_owner;
CREATE DATABASE sight_docs OWNER sight_docs_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE foody, sight, skyline, sight_docs FROM PUBLIC;
GRANT CONNECT ON DATABASE foody, sight, skyline, sight_docs TO ocd_backup;
GRANT CONNECT, TEMPORARY ON DATABASE foody TO foody_owner;
GRANT CONNECT, TEMPORARY ON DATABASE sight TO sight_owner;
GRANT CONNECT, TEMPORARY ON DATABASE skyline TO skyline_owner;
GRANT CONNECT, TEMPORARY ON DATABASE sight_docs TO sight_docs_owner;
