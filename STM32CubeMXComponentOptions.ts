import {ComponentOptions} from "@pango/components";

export interface STM32CubeMXComponentOptions extends ComponentOptions {
    stm32cubemx?: string;
    iocFile?: string;
    flashStart?: number;
    eePromStart?: number;
}