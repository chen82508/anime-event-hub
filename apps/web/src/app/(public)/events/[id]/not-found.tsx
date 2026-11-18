import Link from 'next/link';

export default function EventNotFound() {
  return (
    <div className="empty">
      <h1>找不到這個活動</h1>
      <p>活動可能尚未公開、已下架，或網址有誤。</p>
      <p>
        <Link href="/" className="btn btn-primary">
          回到活動列表
        </Link>
      </p>
    </div>
  );
}
