import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { en, type Messages } from './en'
import { ko } from './ko'

export type Locale = 'en' | 'ko'

const DICTS: Record<Locale, Messages> = { en, ko }
const STORAGE_KEY = 'zto-locale'

function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved === 'en' || saved === 'ko') return saved
  return navigator.language.startsWith('ko') ? 'ko' : 'en'
}

interface I18nValue {
  locale: Locale
  m: Messages
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nValue>({ locale: 'en', m: en, setLocale: () => {} })

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  // main 프로세스도 로케일을 알아야 함 (Touch ID 프롬프트 등 main발 문구)
  useEffect(() => {
    window.zto.setLocale(locale)
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next)
    setLocaleState(next)
  }, [])
  return (
    <I18nContext.Provider value={{ locale, m: DICTS[locale], setLocale }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
