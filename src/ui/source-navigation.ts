/** Obsidian's bare page destination uses FitBH with a null top, which can
 * preserve the old vertical offset. XYZ with null top and zero zoom starts
 * at the requested page's top while retaining the current zoom. */
export function sourceNavigationTarget(target: string): string {
  const match = /^(.*\.pdf)#page=([1-9]\d*)$/iu.exec(target);
  return match ? `${target}&offset=0,,0` : target;
}
