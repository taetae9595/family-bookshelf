-- ============================================================================
--  우리 가족 책장 · 책 검색 (서버가 대신 찾아 주기)
-- ----------------------------------------------------------------------------
--  브라우저에서 구글북스·오픈라이브러리를 직접 부르면
--   · 구글북스는 할당량(429)에 걸리고
--   · 오픈라이브러리는 한국 책이 거의 없어 표지가 안 나옵니다.
--  그래서 서버(Supabase Postgres + pg_net)가 알라딘 검색 결과를 받아
--  제목·저자·표지만 정리해서 돌려줍니다. (가족 비밀번호 필요)
--
--  pg_net 은 응답을 '다음 트랜잭션'에서 읽을 수 있어서 두 단계로 나눴습니다.
--    1) family_search_books_start  : 검색을 시작(또는 캐시된 결과) → request_id
--    2) family_search_books_result : 응답이 왔는지 확인 → { done, items }
--  앱은 0.4초 간격으로 result 를 몇 번 부릅니다. (보통 1~2초 안에 끝남)
-- ============================================================================

create extension if not exists pg_net with schema extensions;

-- 검색어 정리 (공백 정리, 길이 제한) -----------------------------------------
create or replace function private.clean_query(p_q text)
returns text
language sql
immutable
as $$
  select left(regexp_replace(btrim(coalesce(p_q, '')), '\s+', ' ', 'g'), 80);
$$;

revoke all on function private.clean_query(text) from public, anon, authenticated;

-- 검색 결과 캐시 (같은 검색어는 서버에 다시 묻지 않음) -----------------------
create table if not exists private.book_search_cache (
  query      text primary key,
  items      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
revoke all on table private.book_search_cache from public, anon, authenticated;

-- 요청 id ↔ 검색어 (결과를 캐시에 넣을 때 사용) ------------------------------
create table if not exists private.book_search_requests (
  request_id bigint primary key,
  query      text not null,
  created_at timestamptz not null default now()
);
revoke all on table private.book_search_requests from public, anon, authenticated;

-- 알라딘 검색 HTML -> jsonb 배열 ---------------------------------------------
create or replace function private.aladin_parse(p_html text)
returns jsonb
language plpgsql
as $$
declare
  v_parts  text[];
  v_block  text;
  v_out    jsonb := '[]'::jsonb;
  v_cover  text;
  v_title  text;
  v_author text;
  v_year   text;
  v_text   text;
  v_lines  text[];
  i        int;
  j        int;
  n        int;
  m        int;
begin
  if p_html is null or length(p_html) = 0 then
    return '[]'::jsonb;
  end if;

  -- 검색 결과 한 칸은 'class="browse_list_box' 로 시작합니다.
  v_parts := string_to_array(p_html, 'class="browse_list_box');
  n := coalesce(array_length(v_parts, 1), 0);
  if n < 2 then return '[]'::jsonb; end if;

  for i in 2 .. least(n, 29) loop
    v_block := v_parts[i];

    -- 앞표지만 (SpineShelf 는 책등 이미지라 제외)
    v_cover := substring(v_block from '(https://image\.aladin\.co\.kr/product/[^"]*/cover[0-9]*/[^"]+\.jpg)');

    -- 제목
    v_title := substring(v_block from 'b_book_t"[^>]*>([^<]{1,200})');
    if v_title is null then
      continue;
    end if;

    -- 태그를 줄바꿈으로 바꿔 글자만 뽑습니다.
    v_text := regexp_replace(v_block, '<script[^>]*>.*?</script>', ' ', 'gn');
    v_text := regexp_replace(v_text, '<[^>]+>', E'\n', 'g');
    v_text := replace(v_text, '&amp;', '&');
    v_text := replace(v_text, '&lt;', '<');
    v_text := replace(v_text, '&gt;', '>');
    v_text := replace(v_text, '&quot;', '"');
    v_text := replace(v_text, '&#39;', '''');
    v_text := replace(v_text, '&nbsp;', ' ');

    v_lines := array(
      select btrim(x) from unnest(string_to_array(v_text, E'\n')) as x
       where btrim(x) <> ''
    );

    -- 저자: '(지은이)' 같은 표시 바로 앞 줄
    v_author := null;
    v_year := null;
    m := coalesce(array_length(v_lines, 1), 0);
    for j in 2 .. m loop
      if v_lines[j] ~ '^\((지은이|옮긴이|글|그림|엮은이|편|저|감수|기획)\)' then
        v_author := v_lines[j - 1];
        exit;
      end if;
    end loop;

    -- 출간 연도
    for j in 1 .. m loop
      if v_lines[j] ~ '^[0-9]{4}년 [0-9]{2}월$' then
        v_year := left(v_lines[j], 4);
        exit;
      end if;
    end loop;

    v_title := btrim(replace(v_title, '&amp;', '&'));
    if length(v_title) = 0 then continue; end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'title',  v_title,
      'author', coalesce(v_author, ''),
      'year',   coalesce(v_year, ''),
      'cover',  coalesce(v_cover, ''),
      'source', '알라딘'
    ));
  end loop;

  return v_out;
end;
$$;

revoke all on function private.aladin_parse(text) from public, anon, authenticated;

-- 1) 검색 시작 ---------------------------------------------------------------
create or replace function public.family_search_books_start(
  p_passcode  text,
  p_q         text,
  p_family_id text default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_catalog, net
as $$
declare
  v_q      text;
  v_id     bigint;
  v_cached jsonb;
begin
  if not private.check_passcode(p_family_id, p_passcode) then
    raise exception '가족 비밀번호가 달라요.' using errcode = '28000';
  end if;

  v_q := private.clean_query(p_q);
  if length(v_q) < 1 then
    return jsonb_build_object('done', true, 'items', '[]'::jsonb);
  end if;

  select c.items into v_cached
    from private.book_search_cache c
   where c.query = lower(v_q)
     and c.created_at > now() - interval '14 days'
     and jsonb_array_length(c.items) > 0;

  if v_cached is not null then
    return jsonb_build_object('done', true, 'items', v_cached, 'cached', true);
  end if;

  begin
    v_id := net.http_get(
      'https://www.aladin.co.kr/m/msearch.aspx',
      jsonb_build_object('searchtarget', 'book', 'searchword', v_q),
      jsonb_build_object(
        'User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language', 'ko-KR,ko;q=0.9',
        'Accept-Encoding', 'identity'
      ),
      7000
    );
  exception when others then
    return jsonb_build_object('done', true, 'items', '[]'::jsonb, 'error', SQLERRM);
  end;

  insert into private.book_search_requests (request_id, query)
  values (v_id, lower(v_q))
  on conflict (request_id) do nothing;

  return jsonb_build_object('done', false, 'request_id', v_id);
end;
$$;

-- 2) 결과 확인 ---------------------------------------------------------------
create or replace function public.family_search_books_result(
  p_passcode   text,
  p_request_id bigint,
  p_q          text,
  p_family_id  text default 'family'
)
returns jsonb
language plpgsql
security definer
set search_path = private, public, extensions, pg_catalog, net
as $$
declare
  v_body  text;
  v_items jsonb;
  v_q     text;
begin
  if not private.check_passcode(p_family_id, p_passcode) then
    raise exception '가족 비밀번호가 달라요.' using errcode = '28000';
  end if;

  select r.content into v_body from net._http_response r where r.id = p_request_id;

  if v_body is null then
    return jsonb_build_object('done', false);
  end if;

  v_items := private.aladin_parse(v_body);
  v_q := lower(private.clean_query(p_q));

  if jsonb_array_length(v_items) > 0 and length(v_q) > 0 then
    insert into private.book_search_cache (query, items, created_at)
    values (v_q, v_items, now())
    on conflict (query) do update
      set items = excluded.items, created_at = now();
  end if;

  -- 정리: 오래된 응답/요청 기록 삭제
  delete from net._http_response where id = p_request_id;
  delete from private.book_search_requests where request_id = p_request_id;

  return jsonb_build_object('done', true, 'items', v_items, 'source', 'aladin');
end;
$$;

revoke all on function public.family_search_books_start(text, text, text) from public;
revoke all on function public.family_search_books_result(text, bigint, text, text) from public;
grant execute on function public.family_search_books_start(text, text, text) to anon, authenticated;
grant execute on function public.family_search_books_result(text, bigint, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- 확인용:
--   select public.family_search_books_start('가족비밀번호', '불편한 편의점');
--   select public.family_search_books_result('가족비밀번호', <request_id>, '불편한 편의점');
