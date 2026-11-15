# 📚 우리 가족 책장

가족이 함께 보는 **전면 책장(front-facing bookshelf)** 입니다.
읽은 책을 표지가 보이게 꽂고, 표지를 누르면 읽은 날짜 · 별점 · 한줄 감상을 남길 수 있어요.

- 주소: <https://taetae9595.github.io/family-bookshelf/>
- 가족 비밀번호를 한 번 넣으면 그 폰에서는 다시 묻지 않습니다. (같은 비밀번호를 쓰는 가족 달력과 이어져 있어요)
- 화면 코드는 이 저장소에, **책 기록은 Supabase에** 따로 저장됩니다.
  비밀번호는 화면 코드에 없고 Supabase에만(암호화된 해시로) 있습니다.

## 쓰는 방법

1. **+ 책 추가** → 제목이나 저자를 검색하면 인터넷(Google Books · Open Library)에서
   실제 표지를 찾아 보여 줍니다.
2. 마음에 드는 책을 고르면 **오늘 날짜**가 자동으로 들어가고, 그대로 **책장에 꽂기**를 누르면 진열됩니다.
3. 별점(0.5점 단위)과 한줄 감상은 이때 바로 써도 되고, 나중에 표지를 눌러 남겨도 됩니다.
4. 표지를 누르면 **책 기록** 창이 열립니다. 읽은 날짜 · 별점 · 한줄 감상을 고치거나 책을 뺄 수 있어요.
5. 위쪽 검색창에서 책장 안의 책을 찾고, **최신순 / 별점순**으로 정렬합니다.

검색에 없는 책은 **직접 추가하기**로 넣을 수 있습니다.

- **표지 주소(URL)** 를 붙여넣기
- **사진 선택** — 책 표지를 찍은 사진을 넣으면 자동으로 줄여서 저장합니다
- **기본 표지 만들기** — 제목과 저자로 깔끔한 표지를 만들어 줍니다

## 폰 홈 화면에 앱처럼 추가하기

- **안드로이드(Chrome)** — 주소창의 `⋮` → `앱 설치` 또는 `홈 화면에 추가`
- **아이폰(Safari)** — 아래 `공유` 버튼 → `홈 화면에 추가`

## 저장 구조

| 무엇 | 어디에 |
| --- | --- |
| 화면(HTML·JS·표지 아이콘) | 이 GitHub 저장소 / GitHub Pages |
| 책 기록(제목·저자·표지·날짜·별점·감상) | Supabase `public.books` |
| 가족 비밀번호 | Supabase `private.family_secrets` (bcrypt 해시) |

- `anon`(공개) 키로는 `public.books` 를 직접 읽거나 쓸 수 없습니다.
  (RLS 켜짐 + 정책 없음 + 테이블 권한 회수)
- 조회·저장·삭제는 아래 함수로만 되고, 모든 함수가 **먼저 가족 비밀번호를 확인**합니다.
  - `public.family_unlock(p_passcode)` — 비밀번호 확인 (가족 달력과 같은 함수)
  - `public.family_load_books(p_passcode)` — 책 전체 읽기
  - `public.family_save_book(p_passcode, ...)` — 새 책 / 수정
  - `public.family_delete_book(p_passcode, p_id)` — 삭제
- 인터넷이 잠깐 끊기면 그 폰(localStorage)에 먼저 저장해 두고, 다시 연결되면 서버로 올립니다.
- 서버가 "가족 비밀번호가 달라요"라고 하면 자동으로 잠금 화면으로 돌아가 다시 묻습니다.

## 처음부터 다시 만들 때 (참고)

같은 Supabase 프로젝트(`family-calendar`, Northeast Asia · Seoul,
`https://tuejokazctxejnpjmwwt.supabase.co`)를 함께 씁니다.

1. `family-calendar` 의 `supabase-setup.sql` 이 먼저 적용되어 있어야 합니다. (가족 비밀번호 구조)
2. 이 폴더의 **`supabase-setup.sql`** 을 Supabase `SQL Editor` 에 붙여넣고 RUN → `books` 테이블과 함수가 생깁니다.
   (달력의 `schedules` 테이블·함수는 건드리지 않습니다)
3. `index.html` · `app.js` 의 `CONFIG` 에 Project URL 과 publishable 키를 넣습니다.
4. GitHub 저장소 `Settings > Pages` → `Deploy from a branch` / `main` / `/ (root)`.

### 가족 비밀번호 바꾸기

Supabase `SQL Editor` 에서 한 줄:

```sql
select private.set_passcode('새 비밀번호');
```

`index.html` 은 고칠 필요가 없습니다. 이미 열어 둔 폰도 다음 접속 때 다시 입력하게 됩니다.

## 파일

| 파일 | 설명 |
| --- | --- |
| `index.html` | 화면(잠금 · 책장 · 검색 · 기록 창)과 스타일 |
| `app.js` | 동작 전체(Supabase 연결, 책 검색, 표지 생성, 저장) |
| `sw.js` | 서비스 워커 — 화면은 네트워크 우선, 오프라인일 때 캐시 |
| `manifest.json` | 홈 화면 앱(PWA) 설정 |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | 아이콘 |
| `supabase-setup.sql` | `books` 테이블과 RPC 함수 정의 |
