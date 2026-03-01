import { NextResponse } from 'next/server';
import { Resend } from 'resend';

export async function POST(request: Request) {
  try {
    const { message, email } = await request.json();

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.error('RESEND_API_KEY not configured');
      return NextResponse.json({ error: 'Email not configured' }, { status: 500 });
    }

    const resend = new Resend(resendKey);
    const from = process.env.RESEND_FROM_EMAIL || 'info@austintrailconditions.com';
    const replyTo = email && typeof email === 'string' ? email.trim() : undefined;

    await resend.emails.send({
      from,
      to: 'tony.chen@gmail.com',
      replyTo,
      subject: '[Trail Conditions] User Feedback',
      html: `<h3>New Feedback</h3>
        <p>${message.trim().replace(/\n/g, '<br>')}</p>
        ${replyTo ? `<p style="color:#888;font-size:12px">From: ${replyTo}</p>` : ''}`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Feedback error:', msg);
    return NextResponse.json({ error: 'Failed to send feedback' }, { status: 500 });
  }
}
