import { TAG_KIND_LABEL, TAIWAN_CITIES } from '@aeh/core';
import { listTags, listVenues } from '@aeh/db';
import { getDb } from '@/lib/db';
import { addAliasAction, createVenueAction, retagAction } from '../actions';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DictionariesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const db = getDb();
  const [tags, venues] = await Promise.all([listTags(db), listVenues(db)]);
  const ok = one(sp.ok);
  const error = one(sp.error);
  return (
    <>
      <h1>字典快捷操作</h1>
      {ok && <div className="flash ok">{ok}</div>}
      {error && <div className="flash error">{error}</div>}
      <p className="muted">
        後台新增的別名與場館只存在 DB；重新 seed 不會刪除它們（別名只追加）。長期維護請同步到
        data/dictionaries/*.yaml。
      </p>

      <div className="card">
        <h2>新增標籤別名</h2>
        <form action={addAliasAction} className="filters">
          <input type="hidden" name="entity" value="tag" />
          <label>
            標籤
            <select name="targetId" required defaultValue="">
              <option value="" disabled>
                選擇
              </option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {TAG_KIND_LABEL[t.kind]}｜{t.name}（{t.aliases.length} 個別名）
                </option>
              ))}
            </select>
          </label>
          <label>
            別名
            <input name="alias" required placeholder="例：日文原名、英文名、簡稱" />
          </label>
          <button type="submit" className="primary">
            新增
          </button>
        </form>
      </div>

      <div className="card">
        <h2>新增場館別名</h2>
        <form action={addAliasAction} className="filters">
          <input type="hidden" name="entity" value="venue" />
          <label>
            場館
            <select name="targetId" required defaultValue="">
              <option value="" disabled>
                選擇
              </option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.city}｜{v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            別名
            <input name="alias" required placeholder="不要加會指向多個場館的模糊別名" />
          </label>
          <button type="submit" className="primary">
            新增
          </button>
        </form>
      </div>

      <div className="card">
        <h2>新增場館</h2>
        <form action={createVenueAction} className="filters">
          <label>
            slug
            <input
              name="slug"
              required
              placeholder="例：huashan-1914"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
          </label>
          <label>
            名稱
            <input name="name" required />
          </label>
          <label>
            縣市
            <select name="city" required defaultValue="">
              <option value="" disabled>
                選擇
              </option>
              {TAIWAN_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            地址
            <input name="address" />
          </label>
          <label>
            別名（逗號分隔）
            <input name="aliases" />
          </label>
          <button type="submit" className="primary">
            新增
          </button>
        </form>
      </div>

      <div className="card">
        <h2>重新標籤</h2>
        <p className="muted">
          以目前字典重新比對所有待審活動的標籤（只新增、不移除），並判定尚未判定的類型。
        </p>
        <form action={retagAction}>
          <button type="submit">重新標籤待審資料</button>
        </form>
      </div>
    </>
  );
}
