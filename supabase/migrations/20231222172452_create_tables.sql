create table notes (
    id serial primary key,
    title text,
    path text,
    slug text,
    content text,
    publish boolean,
    frontpage boolean,
    "references" text array
);

create table backreferences (
    id serial primary key,
    note_id integer references notes (id),
    backreference text
);

create table details (
    id serial primary key,
    note_id integer references notes (id),
    detail_name text,
    detail_content text
);