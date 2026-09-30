import { CATEGORY_LABELS, SERVICE_CATEGORIES } from '@detailflow/domain'
import { ArrowRight, MapPin, MessageCircle, Phone, Send } from 'lucide-react'
import { Link } from 'react-router'
import { Hours } from '@/public/components/Hours'
import { ServiceRow } from '@/public/components/ServiceRow'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'

export function HomePage() {
  const { slug, storefront } = useTenant()
  const { tenant, profile, services, hours } = storefront
  const categories = SERVICE_CATEGORIES.filter((c) => services.some((s) => s.category === c))

  return (
    <main>
      <section className="relative isolate overflow-hidden">
        {profile.hero_url && (
          <img src={profile.hero_url} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover opacity-90" fetchPriority="high" />
        )}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-background/40 to-background/10" />
        <div className="mx-auto flex min-h-[72dvh] max-w-6xl flex-col justify-end px-4 pt-24 pb-10 sm:min-h-[560px]">
          <p className="font-mono text-[11px] tracking-[0.2em] text-accent uppercase">Детейлинг-студия</p>
          <h1 className="mt-3 max-w-3xl font-display text-[clamp(2rem,7vw,4rem)] leading-[1.02] uppercase">{tenant.name}</h1>
          <p className="mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">{profile.tagline}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to={`/s/${slug}/book`}>
                Записаться <ArrowRight />
              </Link>
            </Button>
            {profile.phone_e164 && (
              <Button asChild size="lg" variant="secondary">
                <a href={`tel:${profile.phone_e164}`}>
                  <Phone /> Позвонить
                </a>
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10" aria-labelledby="services-title">
        <div className="flex items-end justify-between gap-4">
          <h2 id="services-title" className="font-display text-xl uppercase">Услуги</h2>
          <p className="font-mono text-xs text-muted-foreground">{services.length} позиций · цена «от», итог после осмотра</p>
        </div>
        <nav className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Категории">
          {categories.map((c) => (
            <a key={c} href={`#cat-${c}`} className="shrink-0 rounded-sm border border-line-strong px-3 py-1.5 text-xs text-muted-foreground hover:border-accent hover:text-foreground">
              {CATEGORY_LABELS[c]}
            </a>
          ))}
        </nav>
        <div className="mt-4 grid gap-x-10 lg:grid-cols-2">
          {categories.map((c) => (
            <div key={c} id={`cat-${c}`} className="scroll-mt-20">
              {services.filter((s) => s.category === c).map((s) => (
                <ServiceRow key={s.id} service={s} to={`/s/${slug}/services/${s.slug}`} />
              ))}
            </div>
          ))}
        </div>
      </section>

      {profile.gallery.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 pb-10" aria-label="Работы">
          <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4" tabIndex={0} role="region" aria-label="Галерея работ">
            {profile.gallery.map((g) => (
              <figure key={g.url} className="w-[78%] shrink-0 snap-start sm:w-[420px]">
                <img src={g.url} alt={g.caption ?? ''} className="aspect-[4/3] w-full rounded-md border border-line object-cover" loading="lazy" />
                {g.caption && <figcaption className="mt-2 text-xs text-muted-foreground">{g.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      <section className="border-t border-line bg-surface-1">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 md:grid-cols-3">
          <div className="md:col-span-1">
            <h2 className="font-display text-sm uppercase">О студии</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{profile.about}</p>
          </div>
          <div>
            <h2 className="font-display text-sm uppercase">Часы работы</h2>
            <div className="mt-3">
              <Hours hours={hours} />
            </div>
            <p className="mt-2 font-mono text-[11px] text-faint-foreground">Время указано по часовому поясу студии</p>
          </div>
          <div>
            <h2 className="font-display text-sm uppercase">Контакты</h2>
            <ul className="mt-3 space-y-2.5 text-sm">
              <li className="flex gap-2.5">
                <MapPin className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                {profile.map_url ? (
                  <a href={profile.map_url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">{profile.address}</a>
                ) : (
                  <span>{profile.address}</span>
                )}
              </li>
              {profile.phone_e164 && (
                <li className="flex gap-2.5">
                  <Phone className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <a href={`tel:${profile.phone_e164}`} className="font-mono tabular">{profile.phone_display ?? profile.phone_e164}</a>
                </li>
              )}
              {profile.telegram_url && (
                <li className="flex gap-2.5">
                  <Send className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <a href={profile.telegram_url} target="_blank" rel="noreferrer">Telegram</a>
                </li>
              )}
              {profile.whatsapp_url && (
                <li className="flex gap-2.5">
                  <MessageCircle className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  <a href={profile.whatsapp_url} target="_blank" rel="noreferrer">WhatsApp</a>
                </li>
              )}
            </ul>
          </div>
        </div>
      </section>
    </main>
  )
}
