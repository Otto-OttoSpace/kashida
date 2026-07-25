import { SplitText } from 'gsap/SplitText';

export function Title() {
  const el = useRef();
  useEffect(() => {
    new SplitText(el.current, { type: 'chars' });
  }, []);
  return <h1 ref={el} dir="rtl">مرحبا بالعالم</h1>;
}
