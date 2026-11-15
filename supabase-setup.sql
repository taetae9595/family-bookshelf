-- ============================================================================
--  우리 가족 책장 · Supabase 설정 (books 테이블 + RPC 함수)
-- ----------------------------------------------------------------------------
--  이 파일은 'family-calendar' 프로젝트에서 이미 만든 가족 비밀번호 구조
--  (private.family_secrets / private.check_passcode)를 그대로 함께 씁니다.
--  그래서 달력과 책장의 가족 비밀번호가 하나로 같습니다.
--
--  사용법
--   0) 같은 Supabase 프로젝트에 family-calendar 의 supabase-setup.sql 이
--      먼저 적용되어 있어야 합니다(가족 비밀번호 해시가 private 스키마에 있음).
--   1) 아래 SQL 전체를 Supabase 대시보드 > SQL Editor 에 붙여넣고 RUN.
--      (또는 psql 로 같은 DB 에 접속해 실행)
--   2) books 테이블만 새로 생깁니다. 달력의 schedules 테이블·함수는 건드리지 않습니다.
--
--  보안 구조
--   · anon 키로는 public.books 를 직접 읽거나 쓸 수 없습니다.
--     (RLS 켜짐 + 정책 없음 + 테이블 권한 회수)
--   · 조회/저장/삭제는 아래 RPC 함수로만 가능하고, 모든 함수는 먼저
--     가족 비밀번호를 검증합니다(private.check_passcode, bcrypt 해시 비교).
--   · 가족 비밀번호는 화면 코드(index.html/app.js)에 들어가지 않습니다.
-- ============================================================================

-- 0) 선행 조건 확인 ----------------------------------------------------------
do $$
begin
  if to_regprocedure('private.check_passcode(text,text)') is null then
    raise exception '먼저 family-calendar 의 supabase-setup.sql 을 실행해 주세요. (가족 비밀번호 구조를 함께 씁니다)';
  end if;
end $$;

-- 1) 책 테이블 ---------------------------------------------------------------
create table if not exists public.books (
  id         uuid primary key default gen_random_uuid(),
  family_id  text not null default 'family',
  title      text not null check (char_length(btrim(title)) between 1 and 200),
  author     text check (char_length(author) <= 200),
  -- 인터넷 표지 주소(https://...) 또는 사진/기본표지(data:image/... base64)
  cover      text check (cover is null or char_length(cover) <= 700000),
  read_date  date not null default (now() at time zone 'Asia/Seoul')::date,
  -- 별점: 0 ~ 5, 0.5점 단위 (아직 안 매겼으면 null)
  rating     numeric(2,1) check (
               rating is null
               or (rating >= 0 and rating <= 5 and rating * 2 = trunc(rating * 2))
             ),
  review     text check (review is null or char_length(review) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists books_family_date_idx
  on public.books (family_id, read_date desc, created_at desc);

-- RLS 켜고 정책을 만들지 않음 => anon/authenticated 직접 접근 불가
alter table public.books enable row level security;
revoke all on table public.books from public, anon, authenticated;

-- 2) 책 전체 읽기 -------------------------------------------------------------
create or replace function public.family_load_books(
  p_passcode  text,
  p_family_id text default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_catalog
as $$
declare
  v_items jsonb;
begin
  if not private.check_passcode(p_family_id, p_passcode) then
    raise exception '가족 비밀번호가 달라요.' using errcode = '28000';
  end if;

  select coalesce(
           jsonb_agg(to_jsonb(t) order by t.read_date desc, t.created_at desc),
           '[]'::jsonb
         )
    into v_items
    from public.books t
   where t.family_id = p_family_id;

  return jsonb_build_object('items', v_items);
end;
$$;

-- 3) 책 저장 (새 책 / 수정 모두) ----------------------------------------------
create or replace function public.family_save_book(
  p_passcode  text,
  p_id        uuid,
  p_title     text,
  p_author    text    default null,
  p_cover     text    default null,
  p_read_date date    default null,
  p_rating    numeric default null,
  p_review    text    default null,
  p_family_id text    default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_catalog
as $$
declare
  v_row    public.books;
  v_author text;
  v_cover  text;
  v_review text;
  v_date   date;
begin
  if not private.check_passcode(p_family_id, p_passcode) then
    raise exception '가족 비밀번호가 달라요.' using errcode = '28000';
  end if;

  if p_title is null or char_length(btrim(p_title)) = 0 then
    raise exception '책 제목을 입력해 주세요.' using errcode = '22023';
  end if;

  v_author := nullif(btrim(coalesce(p_author, '')), '');
  v_cover  := nullif(btrim(coalesce(p_cover, '')), '');
  v_review := nullif(btrim(coalesce(p_review, '')), '');
  v_date   := coalesce(p_read_date, (now() at time zone 'Asia/Seoul')::date);

  if p_rating is not null
     and (p_rating < 0 or p_rating > 5 or p_rating * 2 <> trunc(p_rating * 2)) then
    raise exception '별점은 0.5점 단위로 0점에서 5점까지예요.' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.books (family_id, title, author, cover, read_date, rating, review)
    values (p_family_id, btrim(p_title), v_author, v_cover, v_date, p_rating, v_review)
    returning * into v_row;
  else
    update public.books b
       set title      = btrim(p_title),
           author     = v_author,
           cover      = v_cover,
           read_date  = v_date,
           rating     = p_rating,
           review     = v_review,
           updated_at = now()
     where b.id = p_id
       and b.family_id = p_family_id
    returning * into v_row;

    if not found then
      insert into public.books (id, family_id, title, author, cover, read_date, rating, review)
      values (p_id, p_family_id, btrim(p_title), v_author, v_cover, v_date, p_rating, v_review)
      returning * into v_row;
    end if;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- 4) 책 삭제 ---------------------------------------------------------------
create or replace function public.family_delete_book(
  p_passcode  text,
  p_id        uuid,
  p_family_id text default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_catalog
as $$
declare
  v_deleted boolean := false;
begin
  if not private.check_passcode(p_family_id, p_passcode) then
    raise exception '가족 비밀번호가 달라요.' using errcode = '28000';
  end if;

  delete from public.books b
   where b.id = p_id
     and b.family_id = p_family_id;

  v_deleted := found;

  return jsonb_build_object('deleted', v_deleted);
end;
$$;

-- 5) 앱(anon 키)에 함수 실행 권한만 부여 --------------------------------------
revoke all on function public.family_load_books(text, text) from public;
revoke all on function public.family_save_book(text, uuid, text, text, text, date, numeric, text, text) from public;
revoke all on function public.family_delete_book(text, uuid, text) from public;

grant execute on function public.family_load_books(text, text) to anon, authenticated;
grant execute on function public.family_save_book(text, uuid, text, text, text, date, numeric, text, text) to anon, authenticated;
grant execute on function public.family_delete_book(text, uuid, text) to anon, authenticated;

-- 6) PostgREST 스키마 캐시 새로고침 -------------------------------------------
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 확인용 (선택): 가족 비밀번호를 넣고 실행하면 설정이 잘 됐는지 볼 수 있습니다.
--   select public.family_unlock('가족비밀번호');      -- true 면 정상
--   select public.family_load_books('가족비밀번호');  -- {"items": []} 면 정상
-- ----------------------------------------------------------------------------
