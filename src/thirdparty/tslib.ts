export function __decorate(decorators: Function[], target: any, _key?: string | symbol, _desc?: any): any {
	let r = target;
	for (let i = decorators.length - 1; i >= 0; i--) {
		let d = decorators[i];
		if (d) {
			r = d(r) || r;
		}
	}
	return r;
}
