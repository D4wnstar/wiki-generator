create table notes (
    id serial primary key,
    title text not null,
    path text unique not null,
    slug text unique not null,
    content text,
    frontpage boolean default false,
    "references" text array
);

create table backreferences (
    note_id integer not null references notes (id),
    slug text not null,
    display_name text not null,
    primary key (note_id, slug)
);

create table details (
    note_id integer not null references notes (id),
    detail_name text not null,
    detail_content text not null,
    primary key (note_id, detail_name)
);

create table sidebar_images (
    note_id integer not null references notes (id),
    image_name text not null,
    caption text,
    primary key (note_id, image_name)
);

create table stored_media (
    id serial primary key,
    media_name text unique not null,
    url text not null,
    media_type text not null
);

create table wiki_settings (
    id serial primary key,
    settings jsonb not null
);