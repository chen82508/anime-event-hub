import { NextResponse, type NextRequest } from 'next/server';

/**
 * /admin Basic Auth（T10 DoD）。帳密來自 ADMIN_BASIC_AUTH（user:password）。
 * 未設定時一律拒絕，避免後台意外公開。通過後把使用者名稱放進 x-admin-user，供 audit_log 記錄操作者。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeBasic(b64: string): string | null {
  try {
    // UTF-8 帳密（atob 只回 latin1）
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const expected = process.env.ADMIN_BASIC_AUTH;
  const header = request.headers.get('authorization') ?? '';
  let user: string | null = null;
  if (expected && expected.includes(':') && header.startsWith('Basic ')) {
    const decoded = decodeBasic(header.slice(6));
    if (decoded !== null && timingSafeEqual(decoded, expected))
      user = decoded.slice(0, decoded.indexOf(':'));
  }
  if (!user) {
    return new NextResponse(expected ? '需要登入' : 'ADMIN_BASIC_AUTH 未設定，後台已停用', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Anime Event Hub Admin", charset="UTF-8"' },
    });
  }
  const headers = new Headers(request.headers);
  headers.set('x-admin-user', user);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
};
