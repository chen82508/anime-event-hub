'use client';

import Form from 'next/form';
import type { ComponentProps, FormEvent } from 'react';

/**
 * next/form（GET、client-side 導覽）＋ 送出前略過空值欄位，
 * 讓網址保持精簡（不會出現 ?q=&from=&to=），方便分享。
 */
export function CleanForm(props: Omit<ComponentProps<typeof Form>, 'onSubmit'>) {
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const disabled: HTMLInputElement[] = [];
    for (const el of e.currentTarget.querySelectorAll<HTMLInputElement>('input[name]')) {
      const unchecked = (el.type === 'checkbox' || el.type === 'radio') && !el.checked;
      if (!el.disabled && !unchecked && el.value === '') {
        el.disabled = true;
        disabled.push(el);
      }
    }
    // FormData 在此事件之後才建立；下一個 tick 恢復，不影響畫面
    setTimeout(() => disabled.forEach((el) => (el.disabled = false)));
  }
  return <Form {...props} onSubmit={onSubmit} />;
}
