create extension pg_jsonschema with schema extensions;

create table wiki_settings (
    id serial primary key,
    settings jsonb not null,

    check (
        jsonb_matches_schema(
            '{
                "title": "string"
            }',
            settings
        )
    )
);