create table notes (
    id serial primary key,
    title text not null,
    path text unique not null,
    slug text unique not null,
    content text,
    publish boolean default false,
    frontpage boolean default false,
    "references" text array
);

create table backreferences (
    id serial primary key,
    note_id integer not null references notes (id),
    display_name text,
    slug text
);

create table details (
    id serial primary key,
    note_id integer not null references notes (id),
    detail_name text,
    detail_content text
);