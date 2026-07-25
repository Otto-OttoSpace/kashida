import { SplitText } from 'gsap/SplitText';

export function Hero() {
  const el = useRef();
  useEffect(() => {
    new SplitText(el.current, { type: 'chars' });
  }, []);
  return <h1 ref={el} className="hero">Hello World</h1>;
}
