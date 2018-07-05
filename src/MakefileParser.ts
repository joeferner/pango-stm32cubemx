interface Results {
    [name: string]: string;
}

export class MakefileParser {
    static parse(makefile: string): Results {
        const results: Results = {};
        const lines = makefile.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            const m = line.match(/^(.*?)=(.*)$/);
            if (m) {
                const name = m[1].trim();
                let value = m[2].trim();
                while (i < lines.length) {
                    let hasContinue = false;
                    if (value.endsWith('\\')) {
                        value = value.substr(0, value.length - 1).trim();
                        hasContinue = true;
                    }
                    if (hasContinue) {
                        i++;
                        value += ' ' + lines[i].trim();
                    } else {
                        break;
                    }
                }
                results[name] = value.trim();
            }
        }
        return results;
    }

    static resolve(vars: Results, str: string): string {
        return str.replace(/\$\((.*?)\)/g, (all, name) => {
            return MakefileParser.resolve(vars, vars[name] || '');
        });
    }

    static stringToArray(str: string): string[] {
        return str.split(' ')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }
}
